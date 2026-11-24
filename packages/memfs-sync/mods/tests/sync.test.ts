import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit, runShell } from "../lib/git.ts";
import { describeOutcome, MemfsSync, parseConfig } from "../lib/sync.ts";

const EMAIL = "agent@example.test";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	}).trim();
}

interface Fixture {
	root: string;
	remote: string;
	local: string;
	other: string;
	key: string;
	allowedSigners: string;
}

function commitFile(dir: string, file: string, content: string, msg: string) {
	writeFileSync(join(dir, file), content);
	git(dir, "add", file);
	git(dir, "commit", "--quiet", "--no-gpg-sign", "-m", msg);
}

function setupFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "memfs-sync-"));
	const remote = join(root, "remote.git");
	const local = join(root, "local");
	const other = join(root, "other");
	const key = join(root, "signing_key");
	execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
	const allowedSigners = join(root, "allowed_signers");
	writeFileSync(
		allowedSigners,
		`${EMAIL} ${readFileSync(`${key}.pub`, "utf8").trim()}\n`,
	);

	git(root, "init", "--quiet", "--bare", "-b", "main", remote);
	for (const dir of [local, other]) {
		git(root, "clone", "--quiet", remote, dir);
		git(dir, "config", "user.name", "Agent");
		git(dir, "config", "user.email", EMAIL);
		git(dir, "config", "commit.gpgsign", "false");
		git(dir, "config", "gpg.format", "ssh");
		git(dir, "config", "gpg.ssh.allowedSignersFile", allowedSigners);
	}
	commitFile(other, "MEMORY.md", "# Memory\n", "init");
	git(other, "push", "--quiet", "origin", "HEAD:main");
	git(local, "pull", "--quiet", "origin", "main");
	git(local, "config", "memfsSync.enabled", "true");
	git(local, "config", "memfsSync.signingKey", `${key}.pub`);
	git(local, "config", "memfsSync.committerEmail", EMAIL);
	return { root, remote, local, other, key, allowedSigners };
}

describe("parseConfig", () => {
	it("defaults to disabled, origin/main, signed, three attempts", () => {
		expect(parseConfig("")).toEqual({
			enabled: false,
			remote: "origin",
			branch: "main",
			sign: true,
			signingKey: null,
			committerName: null,
			committerEmail: null,
			indexCommand: null,
			maxAttempts: 3,
		});
	});

	it("reads lower-cased git config keys, including values with spaces", () => {
		const cfg = parseConfig(
			[
				"memfssync.enabled true",
				"memfssync.remote shared",
				"memfssync.sign false",
				"memfssync.indexcommand python3 memfs.py --dir . index",
				"memfssync.maxattempts 5",
			].join("\n"),
		);
		expect(cfg).toMatchObject({
			enabled: true,
			remote: "shared",
			sign: false,
			indexCommand: "python3 memfs.py --dir . index",
			maxAttempts: 5,
		});
	});
});

describe("MemfsSync against a real git remote", () => {
	let fx: Fixture;
	beforeEach(() => {
		fx = setupFixture();
	});
	afterEach(() => {
		rmSync(fx.root, { recursive: true, force: true });
	});

	it("does nothing unless enabled", async () => {
		git(fx.local, "config", "memfsSync.enabled", "false");
		commitFile(fx.local, "a.md", "a\n", "local");
		expect(await new MemfsSync(fx.local).sync()).toEqual({
			status: "disabled",
		});
		expect(git(fx.remote, "rev-list", "--count", "main")).toBe("1");
	});

	it("fast-forwards when strictly behind", async () => {
		commitFile(fx.other, "b.md", "b\n", "from other agent");
		git(fx.other, "push", "--quiet", "origin", "HEAD:main");
		const outcome = await new MemfsSync(fx.local).sync();
		expect(outcome).toEqual({ status: "fast-forwarded", commits: 1 });
		expect(git(fx.local, "rev-parse", "HEAD")).toBe(
			git(fx.remote, "rev-parse", "main"),
		);
	});

	it("reports up-to-date when nothing moved", async () => {
		expect(await new MemfsSync(fx.local).sync()).toEqual({
			status: "up-to-date",
		});
	});

	it("re-signs and pushes local commits", async () => {
		commitFile(fx.local, "c.md", "c\n", "local memory");
		const outcome = await new MemfsSync(fx.local).sync();
		expect(outcome).toEqual({
			status: "pushed",
			commits: 1,
			indexCommitted: false,
		});
		expect(git(fx.remote, "log", "-1", "--format=%s", "main")).toBe(
			"local memory",
		);
		expect(git(fx.local, "log", "-1", "--format=%G?")).toBe("G");
	});

	it("rebases onto a diverged remote instead of force-pushing", async () => {
		commitFile(fx.other, "d.md", "d\n", "remote memory");
		git(fx.other, "push", "--quiet", "origin", "HEAD:main");
		const remoteTip = git(fx.remote, "rev-parse", "main");
		commitFile(fx.local, "e.md", "e\n", "local memory");

		const outcome = await new MemfsSync(fx.local).sync();
		expect(outcome.status).toBe("pushed");
		// The remote's previous tip is still an ancestor: history was not rewritten.
		git(fx.remote, "merge-base", "--is-ancestor", remoteTip, "main");
		expect(git(fx.remote, "log", "--format=%s", "main").split("\n")).toEqual([
			"local memory",
			"remote memory",
			"init",
		]);
		expect(git(fx.local, "log", "-1", "--format=%G?")).toBe("G");
	});

	it("aborts on a rebase conflict and leaves both sides unchanged", async () => {
		commitFile(fx.other, "MEMORY.md", "# Remote\n", "remote edit");
		git(fx.other, "push", "--quiet", "origin", "HEAD:main");
		const remoteTip = git(fx.remote, "rev-parse", "main");
		commitFile(fx.local, "MEMORY.md", "# Local\n", "local edit");
		const localTip = git(fx.local, "rev-parse", "HEAD");

		const outcome = await new MemfsSync(fx.local).sync();
		expect(outcome.status).toBe("error");
		expect(outcome.status === "error" && outcome.reason).toMatch(/conflict/);
		expect(git(fx.local, "rev-parse", "HEAD")).toBe(localTip);
		expect(git(fx.local, "status", "--porcelain")).toBe("");
		expect(git(fx.remote, "rev-parse", "main")).toBe(remoteTip);
	});

	it("skips when tracked files have uncommitted changes", async () => {
		writeFileSync(join(fx.local, "MEMORY.md"), "# dirty\n");
		expect(await new MemfsSync(fx.local).sync()).toEqual({
			status: "skipped",
			reason: "uncommitted changes in tracked files",
		});
	});

	it("skips when the checkout is on another branch", async () => {
		git(fx.local, "switch", "--quiet", "-c", "reflection");
		const outcome = await new MemfsSync(fx.local).sync();
		expect(outcome).toMatchObject({ status: "skipped" });
	});

	it("commits regenerated indexes without touching unrelated untracked files", async () => {
		writeFileSync(join(fx.local, "scratch.txt"), "keep me untracked\n");
		git(
			fx.local,
			"config",
			"memfsSync.indexCommand",
			"printf '# Memory\\n- [c](c.md)\\n' > MEMORY.md",
		);
		commitFile(fx.local, "c.md", "c\n", "local memory");

		const outcome = await new MemfsSync(fx.local).sync();
		expect(outcome).toEqual({
			status: "pushed",
			commits: 2,
			indexCommitted: true,
		});
		expect(git(fx.remote, "log", "-1", "--format=%s", "main")).toBe(
			"chore(memory): regenerate MEMORY.md indexes",
		);
		expect(git(fx.remote, "show", "main:MEMORY.md")).toContain("[c](c.md)");
		expect(git(fx.local, "status", "--porcelain")).toBe("?? scratch.txt");
		expect(git(fx.local, "log", "-1", "--format=%G?")).toBe("G");
	});

	it("pushes nothing and leaves the checkout clean when the index command fails", async () => {
		git(
			fx.local,
			"config",
			"memfsSync.indexCommand",
			"echo broken > MEMORY.md && echo new > new.md && exit 3",
		);
		commitFile(fx.local, "c.md", "c\n", "local memory");
		const outcome = await new MemfsSync(fx.local).sync();
		expect(outcome.status).toBe("error");
		expect(git(fx.remote, "rev-list", "--count", "main")).toBe("1");
		expect(git(fx.local, "status", "--porcelain")).toBe("");
	});

	it("coalesces concurrent triggers into serialized runs", async () => {
		commitFile(fx.local, "c.md", "c\n", "local memory");
		const syncer = new MemfsSync(fx.local);
		const outcomes = await Promise.all([
			syncer.sync(),
			syncer.sync(),
			syncer.sync(),
		]);
		// One push, then the coalesced follow-up finds nothing left to do.
		expect(outcomes.map((o) => o.status)).toEqual([
			"up-to-date",
			"up-to-date",
			"up-to-date",
		]);
		expect(git(fx.remote, "rev-list", "--count", "main")).toBe("2");
		const log = readFileSync(join(fx.local, ".git", "memfs-sync.log"), "utf8");
		expect(log).toContain('"status":"pushed"');
	});

	it("never publishes a branch switched to while the fetch was in flight", async () => {
		commitFile(fx.local, "c.md", "c\n", "local memory");
		const syncer = new MemfsSync(fx.local, {
			git: async (cwd, args, options) => {
				const result = await runGit(cwd, args, options);
				if (args[0] === "fetch" && cwd === fx.local) {
					git(fx.local, "switch", "--quiet", "-c", "reflection");
					commitFile(fx.local, "reflection.md", "private\n", "reflection only");
				}
				return result;
			},
		});
		await syncer.sync();
		const published = git(fx.remote, "log", "--format=%s", "main").split("\n");
		expect(published).not.toContain("reflection only");
		expect(git(fx.remote, "ls-tree", "--name-only", "main")).not.toContain(
			"reflection.md",
		);
		// The reflection checkout is left exactly as the tool made it.
		expect(git(fx.local, "symbolic-ref", "--short", "HEAD")).toBe("reflection");
		expect(git(fx.local, "log", "-1", "--format=%s")).toBe("reflection only");
	});

	it("keeps memory written during index regeneration out of the index commit", async () => {
		git(fx.local, "config", "memfsSync.indexCommand", "true");
		commitFile(fx.local, "c.md", "c\n", "local memory");
		const syncer = new MemfsSync(fx.local, {
			shell: async (cwd, command) => {
				// Another tool writes memory in the checkout while the index runs.
				writeFileSync(join(fx.local, "concurrent.md"), "in flight\n");
				writeFileSync(join(cwd, "MEMORY.md"), "# Memory\n- [c](c.md)\n");
				return runShell(cwd, command);
			},
		});
		expect(await syncer.sync()).toMatchObject({
			status: "pushed",
			indexCommitted: true,
		});
		expect(git(fx.remote, "ls-tree", "--name-only", "main")).not.toContain(
			"concurrent.md",
		);
		expect(readFileSync(join(fx.local, "concurrent.md"), "utf8")).toBe(
			"in flight\n",
		);
		expect(git(fx.local, "rev-parse", "HEAD")).toBe(
			git(fx.remote, "rev-parse", "main"),
		);
	});

	it("keeps memory written while a failing index command runs", async () => {
		git(fx.local, "config", "memfsSync.indexCommand", "exit 3");
		commitFile(fx.local, "c.md", "c\n", "local memory");
		const syncer = new MemfsSync(fx.local, {
			shell: async (cwd, command) => {
				writeFileSync(join(fx.local, "concurrent.md"), "in flight\n");
				return runShell(cwd, command);
			},
		});
		expect((await syncer.sync()).status).toBe("error");
		expect(readFileSync(join(fx.local, "concurrent.md"), "utf8")).toBe(
			"in flight\n",
		);
		expect(git(fx.remote, "rev-list", "--count", "main")).toBe("1");
	});

	it("does not drop a commit made in the checkout during the push", async () => {
		commitFile(fx.local, "c.md", "c\n", "first");
		const syncer = new MemfsSync(fx.local, {
			git: async (cwd, args, options) => {
				const result = await runGit(cwd, args, options);
				if (args[0] === "push") commitFile(fx.local, "d.md", "d\n", "second");
				return result;
			},
		});
		expect((await syncer.sync()).status).toBe("pushed");
		expect(git(fx.local, "log", "-1", "--format=%s")).toBe("second");
		// The next run rebases the late commit onto what was just pushed.
		expect((await new MemfsSync(fx.local).sync()).status).toBe("pushed");
		expect(git(fx.remote, "log", "--format=%s", "main").split("\n")).toEqual([
			"second",
			"first",
			"init",
		]);
	});

	it("fast-forwards without discarding unrelated uncommitted files", async () => {
		writeFileSync(join(fx.local, "draft.md"), "untracked draft\n");
		commitFile(fx.other, "b.md", "b\n", "from other agent");
		git(fx.other, "push", "--quiet", "origin", "HEAD:main");
		expect((await new MemfsSync(fx.local).sync()).status).toBe(
			"fast-forwarded",
		);
		expect(readFileSync(join(fx.local, "draft.md"), "utf8")).toBe(
			"untracked draft\n",
		);
		expect(readFileSync(join(fx.local, "b.md"), "utf8")).toBe("b\n");
		expect(git(fx.local, "status", "--porcelain")).toBe("?? draft.md");
	});

	it("retries instead of losing a commit a tool makes during the fast-forward", async () => {
		commitFile(fx.other, "b.md", "b\n", "from other agent");
		git(fx.other, "push", "--quiet", "origin", "HEAD:main");
		let lateDone = false;
		const syncer = new MemfsSync(fx.local, {
			git: async (cwd, args, options) => {
				// A tool commits after the remote was fetched but before the checkout
				// fast-forwards. git holds its index lock during merge, so the commit
				// has to land first; the merge must then refuse rather than rewind it.
				if (args[0] === "merge" && cwd === fx.local && !lateDone) {
					lateDone = true;
					commitFile(fx.local, "late.md", "late\n", "late memory");
				}
				return runGit(cwd, args, options);
			},
		});
		expect((await syncer.sync()).status).toBe("pushed");
		expect(git(fx.remote, "log", "--format=%s", "main").split("\n")).toEqual([
			"late memory",
			"from other agent",
			"init",
		]);
		expect(git(fx.local, "rev-parse", "HEAD")).toBe(
			git(fx.remote, "rev-parse", "main"),
		);
	});

	it("reports a fetch failure without changing anything", async () => {
		git(fx.local, "config", "memfsSync.remote", "missing");
		const outcome = await new MemfsSync(fx.local).sync();
		expect(outcome).toMatchObject({ status: "error" });
		expect(describeOutcome(outcome)).toMatch(
			/^memfs-sync: fetch missing\/main failed/,
		);
	});
});
