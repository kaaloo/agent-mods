import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
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

		const blocked = await this.blockedReason(cfg);
		if (blocked) return { status: "skipped", reason: blocked };

		for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
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
				`HEAD...${remoteHead}`,
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
				const ff = await this.git(this.dir, [
					"merge",
					"--ff-only",
					"--quiet",
					remoteHead,
				]);
				if (ff.code !== 0) {
					return {
						status: "error",
						reason: `fast-forward to ${upstream} failed`,
						detail: ff.stderr.trim(),
					};
				}
				return { status: "fast-forwarded", commits: behind };
			}

			// Local commits exist: replay them on the remote tip (re-signing them),
			// regenerate indexes, then push without force.
			const rebased = await this.rebase(cfg, remoteHead);
			if (rebased) return rebased;

			const indexCommitted = await this.regenerateIndex(cfg);
			if (typeof indexCommitted !== "boolean") return indexCommitted;

			const pushed = await this.git(this.dir, [
				"push",
				"--quiet",
				cfg.remote,
				`HEAD:refs/heads/${cfg.branch}`,
			]);
			if (pushed.code === 0) {
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

	private async rebase(
		cfg: SyncConfig,
		onto: string,
	): Promise<SyncOutcome | null> {
		const args = [
			...this.signingArgs(cfg),
			"rebase",
			"--quiet",
			"--no-autostash",
			// Rewrite every unpushed commit, even when the remote has not moved, so
			// each one gets the sync committer identity and signature.
			"--force-rebase",
			cfg.sign ? "--gpg-sign" : "--no-gpg-sign",
			onto,
		];
		const result = await this.git(this.dir, args, {
			env: this.committerEnv(cfg),
		});
		if (result.code === 0) return null;
		await this.git(this.dir, ["rebase", "--abort"]);
		const conflict = /conflict/i.test(result.stdout + result.stderr);
		return {
			status: "error",
			reason: conflict
				? `rebase onto ${cfg.remote}/${cfg.branch} hit a conflict; local commits were left unchanged`
				: `rebase onto ${cfg.remote}/${cfg.branch} failed; local commits were left unchanged`,
			detail: (result.stderr || result.stdout).trim(),
		};
	}

	/** Returns whether an index commit was created, or an error outcome. */
	private async regenerateIndex(
		cfg: SyncConfig,
	): Promise<boolean | SyncOutcome> {
		if (!cfg.indexCommand) return false;
		// Tracked files are clean (checked before syncing), but untracked files may
		// already exist. Only touch paths the index command itself changed.
		const before = await this.dirtyPaths();
		const ran = await this.shell(this.dir, cfg.indexCommand);
		const changed = [...(await this.dirtyPaths())].filter(
			(path) => !before.has(path),
		);
		if (ran.code !== 0) {
			await this.discardPaths(changed);
			return {
				status: "error",
				reason: "index command failed; nothing was pushed",
				detail: (ran.stderr || ran.stdout).trim(),
			};
		}
		if (changed.length === 0) return false;
		await this.git(this.dir, ["add", "--all", "--", ...changed]);
		const commit = await this.git(
			this.dir,
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
			await this.git(this.dir, ["reset", "--quiet", "--", ...changed]);
			await this.discardPaths(changed);
			return {
				status: "error",
				reason: "index commit was rejected; nothing was pushed",
				detail: (commit.stderr || commit.stdout).trim(),
			};
		}
		return true;
	}

	/** Paths with any working-tree or index change, untracked files included. */
	private async dirtyPaths(): Promise<Set<string>> {
		const status = await this.git(this.dir, [
			"status",
			"--porcelain",
			"-z",
			"--untracked-files=all",
		]);
		const paths = new Set<string>();
		const entries = status.stdout.split("\0");
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (entry.length < 4) continue;
			paths.add(entry.slice(3));
			// Renames/copies carry the original path as the next NUL-separated field.
			if (entry[0] === "R" || entry[0] === "C") i++;
		}
		return paths;
	}

	/** Restore tracked paths and delete untracked ones created by the index command. */
	private async discardPaths(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		const tracked = new Set(
			(await this.git(this.dir, ["ls-files", "-z", "--", ...paths])).stdout
				.split("\0")
				.filter(Boolean),
		);
		const restore = paths.filter((path) => tracked.has(path));
		const remove = paths.filter((path) => !tracked.has(path));
		if (restore.length > 0) {
			await this.git(this.dir, ["checkout", "--quiet", "--", ...restore]);
		}
		if (remove.length > 0) {
			await this.git(this.dir, ["clean", "--quiet", "-f", "--", ...remove]);
		}
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
