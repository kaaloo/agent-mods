import { existsSync } from "node:fs";
import { appendFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { type GitResult, type GitRunner, runGit, runShell } from "./git.ts";

/** Per-repository settings, read from `git config` in the memory checkout. */
export interface SyncConfig {
	enabled: boolean;
	remote: string;
	branch: string;
	/** Re-sign rebased commits with the user's signing key (`git rebase -S`). */
	sign: boolean;
	/** Optional `user.signingkey` override used only for sync rewrites. */
	signingKey: string | null;
	/** Committer identity for rewritten commits (GitHub verifies against it). */
	committerName: string | null;
	committerEmail: string | null;
	/** Shell command that regenerates MEMORY.md indexes; changes are committed. */
	indexCommand: string | null;
	maxAttempts: number;
}

export type SyncOutcome =
	| { status: "disabled" }
	| { status: "skipped"; reason: string }
	| { status: "up-to-date" }
	| { status: "fast-forwarded"; commits: number }
	| { status: "pushed"; commits: number; indexCommitted: boolean }
	| { status: "error"; reason: string; detail?: string };

export interface SyncDeps {
	git?: GitRunner;
	shell?: (cwd: string, command: string) => Promise<GitResult>;
	now?: () => Date;
}

const INDEX_COMMIT_MESSAGE = "chore(memory): regenerate MEMORY.md indexes";

function asBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	return ["true", "yes", "on", "1"].includes(value.trim().toLowerCase());
}

function nonEmpty(value: string | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/** Parse `git config --get-regexp ^memfssync\.` output (keys are lower-cased by git). */
export function parseConfig(raw: string): SyncConfig {
	const values = new Map<string, string>();
	for (const line of raw.split("\n")) {
		const match = /^memfssync\.(\S+)\s?(.*)$/.exec(line.trim());
		if (match) values.set(match[1].toLowerCase(), match[2]);
	}
	const attempts = Number.parseInt(values.get("maxattempts") ?? "", 10);
	return {
		enabled: asBool(values.get("enabled"), false),
		remote: nonEmpty(values.get("remote")) ?? "origin",
		branch: nonEmpty(values.get("branch")) ?? "main",
		sign: asBool(values.get("sign"), true),
		signingKey: nonEmpty(values.get("signingkey")),
		committerName: nonEmpty(values.get("committername")),
		committerEmail: nonEmpty(values.get("committeremail")),
		indexCommand: nonEmpty(values.get("indexcommand")),
		maxAttempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 3,
	};
}

export class MemfsSync {
	private readonly git: GitRunner;
	private readonly shell: (cwd: string, command: string) => Promise<GitResult>;
	private readonly now: () => Date;
	private running: Promise<SyncOutcome> | null = null;
	private rerun = false;
	lastOutcome: SyncOutcome | null = null;
	lastRunAt: Date | null = null;

	constructor(
		readonly dir: string,
		deps: SyncDeps = {},
	) {
		this.git = deps.git ?? runGit;
		this.shell = deps.shell ?? ((cwd, command) => runShell(cwd, command));
		this.now = deps.now ?? (() => new Date());
	}

	async loadConfig(): Promise<SyncConfig> {
		const result = await this.git(this.dir, [
			"config",
			"--get-regexp",
			"^memfssync\\.",
		]);
		return parseConfig(result.code === 0 ? result.stdout : "");
	}

	async head(): Promise<string | null> {
		const result = await this.git(this.dir, ["rev-parse", "--verify", "HEAD"]);
		return result.code === 0 ? result.stdout.trim() : null;
	}

	/**
	 * Run one sync. Calls made while a sync is running coalesce into a single
	 * follow-up run, so concurrent triggers never race each other in git.
	 */
	sync(): Promise<SyncOutcome> {
		if (this.running) {
			this.rerun = true;
			return this.running;
		}
		this.running = (async () => {
			let outcome: SyncOutcome;
			do {
				this.rerun = false;
				outcome = await this.syncOnce();
			} while (this.rerun);
			return outcome;
		})().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async syncOnce(): Promise<SyncOutcome> {
		let outcome: SyncOutcome;
		try {
			outcome = await this.attempt();
		} catch (error) {
			outcome = {
				status: "error",
				reason: "unexpected failure",
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		this.lastOutcome = outcome;
		this.lastRunAt = this.now();
		if (outcome.status !== "disabled") await this.log(outcome);
		return outcome;
	}

	private async attempt(): Promise<SyncOutcome> {
		if (!existsSync(join(this.dir, ".git"))) {
			return { status: "skipped", reason: "not a git checkout" };
		}
		const cfg = await this.loadConfig();
		if (!cfg.enabled) return { status: "disabled" };

		for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
			const blocked = await this.blockedReason(cfg);
			if (blocked) return { status: "skipped", reason: blocked };
			// Pin the commit being synced. Everything below works from this sha, not
			// from whatever HEAD happens to be after a network wait, so a tool that
			// switches branches or commits meanwhile cannot leak into the push.
			const localHead = (
				await this.git(this.dir, [
					"rev-parse",
					"--verify",
					"--quiet",
					`refs/heads/${cfg.branch}`,
				])
			).stdout.trim();
			if (!localHead) return { status: "skipped", reason: "no commits yet" };

			const fetched = await this.git(this.dir, [
				"fetch",
				"--quiet",
				"--no-tags",
				cfg.remote,
				cfg.branch,
			]);
			if (fetched.code !== 0) {
				return {
					status: "error",
					reason: `fetch ${cfg.remote}/${cfg.branch} failed`,
					detail: fetched.stderr.trim(),
				};
			}
			const upstream = `${cfg.remote}/${cfg.branch}`;
			// FETCH_HEAD is authoritative even when no remote-tracking refspec exists.
			const remoteHead = (
				await this.git(this.dir, ["rev-parse", "--verify", "FETCH_HEAD"])
			).stdout.trim();
			const counts = await this.git(this.dir, [
				"rev-list",
				"--left-right",
				"--count",
				`${localHead}...${remoteHead}`,
			]);
			if (counts.code !== 0) {
				return {
					status: "error",
					reason: "could not compare with remote",
					detail: counts.stderr.trim(),
				};
			}
			const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);

			if (ahead === 0) {
				if (behind === 0) return { status: "up-to-date" };
				const moved = await this.advanceCheckout(cfg, localHead, remoteHead);
				if (moved === "raced") continue;
				if (moved !== "ok") return moved;
				return { status: "fast-forwarded", commits: behind };
			}

			// Local commits exist. Rebase, re-sign and index them in a private
			// worktree so concurrent memory writes in the checkout are never touched,
			// then push the resulting commit without force.
			const prepared = await this.prepareInWorktree(cfg, localHead, remoteHead);
			if (prepared.status) return prepared.status;
			const { newHead, indexCommitted } = prepared;

			const pushed = await this.git(this.dir, [
				"push",
				"--quiet",
				cfg.remote,
				`${newHead}:refs/heads/${cfg.branch}`,
			]);
			if (pushed.code === 0) {
				// Best effort: the remote is already correct. If the checkout moved
				// meanwhile, the next run rebases the new commits onto the pushed tip.
				await this.advanceCheckout(cfg, localHead, newHead);
				const total = ahead + (indexCommitted ? 1 : 0);
				return { status: "pushed", commits: total, indexCommitted };
			}
			const rejected = /\b(rejected|non-fast-forward|fetch first)\b/i.test(
				pushed.stderr,
			);
			if (!rejected || attempt === cfg.maxAttempts) {
				return {
					status: "error",
					reason: rejected
						? `push kept being rejected after ${cfg.maxAttempts} attempts`
						: `push to ${upstream} failed`,
					detail: pushed.stderr.trim(),
				};
			}
			// The remote moved between fetch and push: loop to fetch and rebase again.
		}
		return { status: "error", reason: "sync attempts exhausted" };
	}

	/**
	 * Move the configured branch from `from` to `to` with a compare-and-swap, so
	 * a commit made meanwhile is never dropped. When the branch is checked out,
	 * the working tree follows through a two-tree `read-tree -m -u`, which keeps
	 * unrelated local edits and refuses to overwrite conflicting or untracked
	 * files; on refusal the ref is swapped back. Returns "raced" when the branch
	 * moved under us.
	 */
	private async advanceCheckout(
		cfg: SyncConfig,
		from: string,
		to: string,
	): Promise<"ok" | "raced" | SyncOutcome> {
		const ref = `refs/heads/${cfg.branch}`;
		const swapped = await this.git(this.dir, [
			"update-ref",
			"-m",
			"memfs-sync",
			ref,
			to,
			from,
		]);
		if (swapped.code !== 0) return "raced";
		const checkedOut = (
			await this.git(this.dir, ["symbolic-ref", "--quiet", "HEAD"])
		).stdout.trim();
		if (checkedOut !== ref) return "ok";
		const updated = await this.git(this.dir, [
			"read-tree",
			"-m",
			"-u",
			from,
			to,
		]);
		if (updated.code === 0) return "ok";
		await this.git(this.dir, [
			"update-ref",
			"-m",
			"memfs-sync revert",
			ref,
			from,
			to,
		]);
		return {
			status: "error",
			reason: `could not update the checkout to ${cfg.remote}/${cfg.branch} without overwriting local files`,
			detail: updated.stderr.trim(),
		};
	}

	private async worktreePath(): Promise<string> {
		const common = (
			await this.git(this.dir, [
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
			])
		).stdout.trim();
		return join(common, "memfs-sync", "worktree");
	}

	/** Detached private worktree at `commit`, created on first use and reset after. */
	private async freshWorktree(commit: string): Promise<string | SyncOutcome> {
		const path = await this.worktreePath();
		if (existsSync(join(path, ".git"))) {
			await this.git(path, ["rebase", "--abort"]);
			const reset = await this.git(path, [
				"checkout",
				"--quiet",
				"--force",
				"--detach",
				commit,
			]);
			await this.git(path, ["clean", "--quiet", "-fdx"]);
			if (reset.code === 0) return path;
		}
		await this.git(this.dir, ["worktree", "prune"]);
		await rm(path, { recursive: true, force: true });
		const added = await this.git(this.dir, [
			"worktree",
			"add",
			"--quiet",
			"--force",
			"--detach",
			path,
			commit,
		]);
		if (added.code !== 0) {
			return {
				status: "error",
				reason: "could not create the private sync worktree",
				detail: added.stderr.trim(),
			};
		}
		return path;
	}

	private async prepareInWorktree(
		cfg: SyncConfig,
		localHead: string,
		remoteHead: string,
	): Promise<
		| { status: SyncOutcome; newHead?: undefined; indexCommitted?: undefined }
		| { status: null; newHead: string; indexCommitted: boolean }
	> {
		const worktree = await this.freshWorktree(localHead);
		if (typeof worktree !== "string") return { status: worktree };

		const rebased = await this.git(
			worktree,
			[
				...this.signingArgs(cfg),
				"rebase",
				"--quiet",
				"--no-autostash",
				// Rewrite every unpushed commit, even when the remote has not moved, so
				// each one gets the sync committer identity and signature.
				"--force-rebase",
				cfg.sign ? "--gpg-sign" : "--no-gpg-sign",
				remoteHead,
			],
			{ env: this.committerEnv(cfg) },
		);
		if (rebased.code !== 0) {
			await this.git(worktree, ["rebase", "--abort"]);
			const conflict = /conflict/i.test(rebased.stdout + rebased.stderr);
			return {
				status: {
					status: "error",
					reason: conflict
						? `rebase onto ${cfg.remote}/${cfg.branch} hit a conflict; local commits were left unchanged`
						: `rebase onto ${cfg.remote}/${cfg.branch} failed; local commits were left unchanged`,
					detail: (rebased.stderr || rebased.stdout).trim(),
				},
			};
		}

		let indexCommitted = false;
		if (cfg.indexCommand) {
			const ran = await this.shell(worktree, cfg.indexCommand);
			if (ran.code !== 0) {
				return {
					status: {
						status: "error",
						reason: "index command failed; nothing was pushed",
						detail: (ran.stderr || ran.stdout).trim(),
					},
				};
			}
			const status = await this.git(worktree, ["status", "--porcelain"]);
			if (status.stdout.trim()) {
				// The worktree is private and started clean, so every change is the
				// index command's own output.
				await this.git(worktree, ["add", "--all"]);
				const commit = await this.git(
					worktree,
					[
						...this.signingArgs(cfg),
						"commit",
						"--quiet",
						cfg.sign ? "--gpg-sign" : "--no-gpg-sign",
						"-m",
						INDEX_COMMIT_MESSAGE,
					],
					{ env: this.committerEnv(cfg) },
				);
				if (commit.code !== 0) {
					return {
						status: {
							status: "error",
							reason: "index commit was rejected; nothing was pushed",
							detail: (commit.stderr || commit.stdout).trim(),
						},
					};
				}
				indexCommitted = true;
			}
		}
		const newHead = (
			await this.git(worktree, ["rev-parse", "--verify", "HEAD"])
		).stdout.trim();
		return { status: null, newHead, indexCommitted };
	}

	private async blockedReason(cfg: SyncConfig): Promise<string | null> {
		const gitDir = (
			await this.git(this.dir, ["rev-parse", "--absolute-git-dir"])
		).stdout.trim();
		for (const marker of [
			"rebase-merge",
			"rebase-apply",
			"MERGE_HEAD",
			"CHERRY_PICK_HEAD",
		]) {
			if (gitDir && existsSync(join(gitDir, marker))) {
				return `a git ${marker.toLowerCase().replace(/_head$/, "")} is in progress`;
			}
		}
		const branch = (
			await this.git(this.dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])
		).stdout.trim();
		if (branch !== cfg.branch) {
			return `checkout is on '${branch || "detached HEAD"}', not '${cfg.branch}'`;
		}
		const status = await this.git(this.dir, [
			"status",
			"--porcelain",
			"--untracked-files=no",
		]);
		if (status.code !== 0) return "git status failed";
		if (status.stdout.trim()) return "uncommitted changes in tracked files";
		return null;
	}

	private signingArgs(cfg: SyncConfig): string[] {
		return cfg.signingKey ? ["-c", `user.signingkey=${cfg.signingKey}`] : [];
	}

	private committerEnv(cfg: SyncConfig): Record<string, string> {
		const env: Record<string, string> = {};
		if (cfg.committerName) env.GIT_COMMITTER_NAME = cfg.committerName;
		if (cfg.committerEmail) env.GIT_COMMITTER_EMAIL = cfg.committerEmail;
		return env;
	}

	private async log(outcome: SyncOutcome): Promise<void> {
		const gitDir = (
			await this.git(this.dir, ["rev-parse", "--absolute-git-dir"])
		).stdout.trim();
		if (!gitDir || !isAbsolute(gitDir)) return;
		const line = `${this.now().toISOString()} ${JSON.stringify(outcome)}\n`;
		await appendFile(join(gitDir, "memfs-sync.log"), line).catch(() => {});
	}
}

/** One-line human summary, or null when the outcome is not worth surfacing. */
export function describeOutcome(outcome: SyncOutcome): string | null {
	switch (outcome.status) {
		case "fast-forwarded":
			return `memfs-sync: pulled ${outcome.commits} commit(s) from the shared memory repository.`;
		case "pushed":
			return `memfs-sync: pushed ${outcome.commits} commit(s)${outcome.indexCommitted ? " (including regenerated indexes)" : ""}.`;
		case "error":
			return `memfs-sync: ${outcome.reason}.${outcome.detail ? ` ${outcome.detail.split("\n")[0]}` : ""}`;
		default:
			return null;
	}
}
