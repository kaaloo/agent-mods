// mods/lib/sync.ts
import { existsSync } from "node:fs";
import { appendFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// mods/lib/git.ts
import { execFile } from "node:child_process";
var DEFAULT_TIMEOUT_MS = 60000;
var runGit = (cwd, args, options = {}) => new Promise((resolve) => {
  execFile("git", args, {
    cwd,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      ...options.env
    }
  }, (error, stdout, stderr) => {
    const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});
var runShell = (cwd, command, timeoutMs = DEFAULT_TIMEOUT_MS) => new Promise((resolve) => {
  execFile(process.env.SHELL || "/bin/sh", ["-c", command], { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
});

// mods/lib/sync.ts
var INDEX_COMMIT_MESSAGE = "chore(memory): regenerate MEMORY.md indexes";
function asBool(value, fallback) {
  if (value === undefined)
    return fallback;
  return ["true", "yes", "on", "1"].includes(value.trim().toLowerCase());
}
function nonEmpty(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
function parseConfig(raw) {
  const values = new Map;
  for (const line of raw.split(`
`)) {
    const match = /^memfssync\.(\S+)\s?(.*)$/.exec(line.trim());
    if (match)
      values.set(match[1].toLowerCase(), match[2]);
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
    maxAttempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 3
  };
}

class MemfsSync {
  dir;
  git;
  shell;
  now;
  running = null;
  rerun = false;
  lastOutcome = null;
  lastRunAt = null;
  constructor(dir, deps = {}) {
    this.dir = dir;
    this.git = deps.git ?? runGit;
    this.shell = deps.shell ?? ((cwd, command) => runShell(cwd, command));
    this.now = deps.now ?? (() => new Date);
  }
  async loadConfig() {
    const result = await this.git(this.dir, [
      "config",
      "--get-regexp",
      "^memfssync\\."
    ]);
    return parseConfig(result.code === 0 ? result.stdout : "");
  }
  async head() {
    const result = await this.git(this.dir, ["rev-parse", "--verify", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() : null;
  }
  sync() {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      let outcome;
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
  async syncOnce() {
    let outcome;
    try {
      outcome = await this.attempt();
    } catch (error) {
      outcome = {
        status: "error",
        reason: "unexpected failure",
        detail: error instanceof Error ? error.message : String(error)
      };
    }
    this.lastOutcome = outcome;
    this.lastRunAt = this.now();
    if (outcome.status !== "disabled")
      await this.log(outcome);
    return outcome;
  }
  async attempt() {
    if (!existsSync(join(this.dir, ".git"))) {
      return { status: "skipped", reason: "not a git checkout" };
    }
    const cfg = await this.loadConfig();
    if (!cfg.enabled)
      return { status: "disabled" };
    for (let attempt = 1;attempt <= cfg.maxAttempts; attempt++) {
      const blocked = await this.blockedReason(cfg);
      if (blocked)
        return { status: "skipped", reason: blocked };
      const localHead = (await this.git(this.dir, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${cfg.branch}`
      ])).stdout.trim();
      if (!localHead)
        return { status: "skipped", reason: "no commits yet" };
      const fetched = await this.git(this.dir, [
        "fetch",
        "--quiet",
        "--no-tags",
        cfg.remote,
        cfg.branch
      ]);
      if (fetched.code !== 0) {
        return {
          status: "error",
          reason: `fetch ${cfg.remote}/${cfg.branch} failed`,
          detail: fetched.stderr.trim()
        };
      }
      const upstream = `${cfg.remote}/${cfg.branch}`;
      const remoteHead = (await this.git(this.dir, ["rev-parse", "--verify", "FETCH_HEAD"])).stdout.trim();
      const counts = await this.git(this.dir, [
        "rev-list",
        "--left-right",
        "--count",
        `${localHead}...${remoteHead}`
      ]);
      if (counts.code !== 0) {
        return {
          status: "error",
          reason: "could not compare with remote",
          detail: counts.stderr.trim()
        };
      }
      const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
      if (ahead === 0) {
        if (behind === 0)
          return { status: "up-to-date" };
        const moved = await this.advanceCheckout(cfg, localHead, remoteHead);
        if (moved === "raced")
          continue;
        if (moved !== "ok")
          return moved;
        return { status: "fast-forwarded", commits: behind };
      }
      const prepared = await this.prepareInWorktree(cfg, localHead, remoteHead);
      if (prepared.status)
        return prepared.status;
      const { newHead, indexCommitted } = prepared;
      const pushed = await this.git(this.dir, [
        "push",
        "--quiet",
        cfg.remote,
        `${newHead}:refs/heads/${cfg.branch}`
      ]);
      if (pushed.code === 0) {
        await this.advanceCheckout(cfg, localHead, newHead);
        const total = ahead + (indexCommitted ? 1 : 0);
        return { status: "pushed", commits: total, indexCommitted };
      }
      const rejected = /\b(rejected|non-fast-forward|fetch first)\b/i.test(pushed.stderr);
      if (!rejected || attempt === cfg.maxAttempts) {
        return {
          status: "error",
          reason: rejected ? `push kept being rejected after ${cfg.maxAttempts} attempts` : `push to ${upstream} failed`,
          detail: pushed.stderr.trim()
        };
      }
    }
    return { status: "error", reason: "sync attempts exhausted" };
  }
  async advanceCheckout(cfg, from, to) {
    const ref = `refs/heads/${cfg.branch}`;
    const swapped = await this.git(this.dir, [
      "update-ref",
      "-m",
      "memfs-sync",
      ref,
      to,
      from
    ]);
    if (swapped.code !== 0)
      return "raced";
    const checkedOut = (await this.git(this.dir, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trim();
    if (checkedOut !== ref)
      return "ok";
    const updated = await this.git(this.dir, [
      "read-tree",
      "-m",
      "-u",
      from,
      to
    ]);
    if (updated.code === 0)
      return "ok";
    await this.git(this.dir, [
      "update-ref",
      "-m",
      "memfs-sync revert",
      ref,
      from,
      to
    ]);
    return {
      status: "error",
      reason: `could not update the checkout to ${cfg.remote}/${cfg.branch} without overwriting local files`,
      detail: updated.stderr.trim()
    };
  }
  async worktreePath() {
    const common = (await this.git(this.dir, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir"
    ])).stdout.trim();
    return join(common, "memfs-sync", "worktree");
  }
  async freshWorktree(commit) {
    const path = await this.worktreePath();
    if (existsSync(join(path, ".git"))) {
      await this.git(path, ["rebase", "--abort"]);
      const reset = await this.git(path, [
        "checkout",
        "--quiet",
        "--force",
        "--detach",
        commit
      ]);
      await this.git(path, ["clean", "--quiet", "-fdx"]);
      if (reset.code === 0)
        return path;
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
      commit
    ]);
    if (added.code !== 0) {
      return {
        status: "error",
        reason: "could not create the private sync worktree",
        detail: added.stderr.trim()
      };
    }
    return path;
  }
  async prepareInWorktree(cfg, localHead, remoteHead) {
    const worktree = await this.freshWorktree(localHead);
    if (typeof worktree !== "string")
      return { status: worktree };
    const rebased = await this.git(worktree, [
      ...this.signingArgs(cfg),
      "rebase",
      "--quiet",
      "--no-autostash",
      "--force-rebase",
      cfg.sign ? "--gpg-sign" : "--no-gpg-sign",
      remoteHead
    ], { env: this.committerEnv(cfg) });
    if (rebased.code !== 0) {
      await this.git(worktree, ["rebase", "--abort"]);
      const conflict = /conflict/i.test(rebased.stdout + rebased.stderr);
      return {
        status: {
          status: "error",
          reason: conflict ? `rebase onto ${cfg.remote}/${cfg.branch} hit a conflict; local commits were left unchanged` : `rebase onto ${cfg.remote}/${cfg.branch} failed; local commits were left unchanged`,
          detail: (rebased.stderr || rebased.stdout).trim()
        }
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
            detail: (ran.stderr || ran.stdout).trim()
          }
        };
      }
      const status = await this.git(worktree, ["status", "--porcelain"]);
      if (status.stdout.trim()) {
        await this.git(worktree, ["add", "--all"]);
        const commit = await this.git(worktree, [
          ...this.signingArgs(cfg),
          "commit",
          "--quiet",
          cfg.sign ? "--gpg-sign" : "--no-gpg-sign",
          "-m",
          INDEX_COMMIT_MESSAGE
        ], { env: this.committerEnv(cfg) });
        if (commit.code !== 0) {
          return {
            status: {
              status: "error",
              reason: "index commit was rejected; nothing was pushed",
              detail: (commit.stderr || commit.stdout).trim()
            }
          };
        }
        indexCommitted = true;
      }
    }
    const newHead = (await this.git(worktree, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    return { status: null, newHead, indexCommitted };
  }
  async blockedReason(cfg) {
    const gitDir = (await this.git(this.dir, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    for (const marker of [
      "rebase-merge",
      "rebase-apply",
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD"
    ]) {
      if (gitDir && existsSync(join(gitDir, marker))) {
        return `a git ${marker.toLowerCase().replace(/_head$/, "")} is in progress`;
      }
    }
    const branch = (await this.git(this.dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
    if (branch !== cfg.branch) {
      return `checkout is on '${branch || "detached HEAD"}', not '${cfg.branch}'`;
    }
    const status = await this.git(this.dir, [
      "status",
      "--porcelain",
      "--untracked-files=no"
    ]);
    if (status.code !== 0)
      return "git status failed";
    if (status.stdout.trim())
      return "uncommitted changes in tracked files";
    return null;
  }
  signingArgs(cfg) {
    return cfg.signingKey ? ["-c", `user.signingkey=${cfg.signingKey}`] : [];
  }
  committerEnv(cfg) {
    const env = {};
    if (cfg.committerName)
      env.GIT_COMMITTER_NAME = cfg.committerName;
    if (cfg.committerEmail)
      env.GIT_COMMITTER_EMAIL = cfg.committerEmail;
    return env;
  }
  async log(outcome) {
    const gitDir = (await this.git(this.dir, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    if (!gitDir || !isAbsolute(gitDir))
      return;
    const line = `${this.now().toISOString()} ${JSON.stringify(outcome)}
`;
    await appendFile(join(gitDir, "memfs-sync.log"), line).catch(() => {});
  }
}
function describeOutcome(outcome) {
  switch (outcome.status) {
    case "fast-forwarded":
      return `memfs-sync: pulled ${outcome.commits} commit(s) from the shared memory repository.`;
    case "pushed":
      return `memfs-sync: pushed ${outcome.commits} commit(s)${outcome.indexCommitted ? " (including regenerated indexes)" : ""}.`;
    case "error":
      return `memfs-sync: ${outcome.reason}.${outcome.detail ? ` ${outcome.detail.split(`
`)[0]}` : ""}`;
    default:
      return null;
  }
}

// mods/index.ts
var COMMIT_CAPABLE_TOOLS = new Set([
  "Bash",
  "Shell",
  "memory",
  "ShellCommand"
]);
function memoryDirFromContext(ctx) {
  const memfs = ctx?.memfs;
  if (memfs && memfs.enabled !== false && typeof memfs.memoryDir === "string") {
    return memfs.memoryDir || null;
  }
  const fromEnv = process.env.MEMORY_DIR || process.env.LETTA_MEMORY_DIR;
  return fromEnv || null;
}
function activate(letta) {
  const disposers = [];
  const syncers = new Map;
  const lastHeads = new Map;
  const syncerFor = (dir) => {
    let syncer = syncers.get(dir);
    if (!syncer) {
      syncer = new MemfsSync(dir);
      syncers.set(dir, syncer);
    }
    return syncer;
  };
  const report = (outcome) => {
    const message = describeOutcome(outcome);
    if (!message)
      return;
    if (letta.capabilities?.ui?.panels && letta.ui?.notify) {
      letta.ui.notify(message);
    } else if (outcome.status === "error") {
      console.warn(message);
    }
  };
  const runSync = async (dir) => {
    const syncer = syncerFor(dir);
    const outcome = await syncer.sync();
    lastHeads.set(dir, await syncer.head());
    report(outcome);
    return outcome;
  };
  const syncIfHeadMoved = async (dir) => {
    const head = await syncerFor(dir).head();
    if (lastHeads.has(dir) && lastHeads.get(dir) === head)
      return;
    await runSync(dir);
  };
  if (letta.capabilities?.events?.turns) {
    disposers.push(letta.events.on("turn_start", async (_event, ctx) => {
      const dir = memoryDirFromContext(ctx);
      if (dir)
        await runSync(dir);
    }));
  }
  if (letta.capabilities?.events?.lifecycle) {
    disposers.push(letta.events.on("conversation_open", (_event, ctx) => {
      const dir = memoryDirFromContext(ctx);
      if (dir)
        runSync(dir);
    }));
  }
  if (letta.capabilities?.events?.tools) {
    disposers.push(letta.events.on("tool_end", (event, ctx) => {
      if (event.status !== "success")
        return;
      if (!COMMIT_CAPABLE_TOOLS.has(event.toolName ?? ""))
        return;
      const dir = memoryDirFromContext(ctx);
      if (dir)
        syncIfHeadMoved(dir);
    }));
  }
  if (letta.capabilities?.commands && letta.commands) {
    disposers.push(letta.commands.register({
      id: "memfs-sync",
      description: "Sync the memory checkout with its shared repository (or `status`)",
      args: "[status]",
      async run(ctx) {
        const dir = memoryDirFromContext(ctx);
        if (!dir) {
          return {
            type: "output",
            output: "memfs-sync: MemFS is not enabled."
          };
        }
        const syncer = syncerFor(dir);
        if ((ctx.args ?? "").trim() === "status") {
          const cfg = await syncer.loadConfig();
          const last = syncer.lastOutcome ? `${syncer.lastRunAt?.toISOString()} ${JSON.stringify(syncer.lastOutcome)}` : "no sync yet in this session";
          return {
            type: "output",
            output: [
              `memfs-sync: ${dir}`,
              `  enabled: ${cfg.enabled}  remote: ${cfg.remote}/${cfg.branch}  sign: ${cfg.sign}`,
              `  index command: ${cfg.indexCommand ?? "(none)"}`,
              `  last: ${last}`
            ].join(`
`)
          };
        }
        const outcome = await syncer.sync();
        lastHeads.set(dir, await syncer.head());
        return {
          type: "output",
          output: describeOutcome(outcome) ?? `memfs-sync: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}.`
        };
      }
    }));
  }
  return () => {
    for (const dispose of disposers.reverse())
      dispose();
  };
}
export {
  activate as default,
  memoryDirFromContext
};
