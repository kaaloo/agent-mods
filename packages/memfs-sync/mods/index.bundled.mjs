// mods/lib/sync.ts
import { existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
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
    const blocked = await this.blockedReason(cfg);
    if (blocked)
      return { status: "skipped", reason: blocked };
    for (let attempt = 1;attempt <= cfg.maxAttempts; attempt++) {
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
        `HEAD...${remoteHead}`
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
        const ff = await this.git(this.dir, [
          "merge",
          "--ff-only",
          "--quiet",
          remoteHead
        ]);
        if (ff.code !== 0) {
          return {
            status: "error",
            reason: `fast-forward to ${upstream} failed`,
            detail: ff.stderr.trim()
          };
        }
        return { status: "fast-forwarded", commits: behind };
      }
      const rebased = await this.rebase(cfg, remoteHead);
      if (rebased)
        return rebased;
      const indexCommitted = await this.regenerateIndex(cfg);
      if (typeof indexCommitted !== "boolean")
        return indexCommitted;
      const pushed = await this.git(this.dir, [
        "push",
        "--quiet",
        cfg.remote,
        `HEAD:refs/heads/${cfg.branch}`
      ]);
      if (pushed.code === 0) {
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
  async rebase(cfg, onto) {
    const args = [
      ...this.signingArgs(cfg),
      "rebase",
      "--quiet",
      "--no-autostash",
      "--force-rebase",
      cfg.sign ? "--gpg-sign" : "--no-gpg-sign",
      onto
    ];
    const result = await this.git(this.dir, args, {
      env: this.committerEnv(cfg)
    });
    if (result.code === 0)
      return null;
    await this.git(this.dir, ["rebase", "--abort"]);
    const conflict = /conflict/i.test(result.stdout + result.stderr);
    return {
      status: "error",
      reason: conflict ? `rebase onto ${cfg.remote}/${cfg.branch} hit a conflict; local commits were left unchanged` : `rebase onto ${cfg.remote}/${cfg.branch} failed; local commits were left unchanged`,
      detail: (result.stderr || result.stdout).trim()
    };
  }
  async regenerateIndex(cfg) {
    if (!cfg.indexCommand)
      return false;
    const before = await this.dirtyPaths();
    const ran = await this.shell(this.dir, cfg.indexCommand);
    const changed = [...await this.dirtyPaths()].filter((path) => !before.has(path));
    if (ran.code !== 0) {
      await this.discardPaths(changed);
      return {
        status: "error",
        reason: "index command failed; nothing was pushed",
        detail: (ran.stderr || ran.stdout).trim()
      };
    }
    if (changed.length === 0)
      return false;
    await this.git(this.dir, ["add", "--all", "--", ...changed]);
    const commit = await this.git(this.dir, [
      ...this.signingArgs(cfg),
      "commit",
      "--quiet",
      cfg.sign ? "--gpg-sign" : "--no-gpg-sign",
      "-m",
      INDEX_COMMIT_MESSAGE
    ], { env: this.committerEnv(cfg) });
    if (commit.code !== 0) {
      await this.git(this.dir, ["reset", "--quiet", "--", ...changed]);
      await this.discardPaths(changed);
      return {
        status: "error",
        reason: "index commit was rejected; nothing was pushed",
        detail: (commit.stderr || commit.stdout).trim()
      };
    }
    return true;
  }
  async dirtyPaths() {
    const status = await this.git(this.dir, [
      "status",
      "--porcelain",
      "-z",
      "--untracked-files=all"
    ]);
    const paths = new Set;
    const entries = status.stdout.split("\x00");
    for (let i = 0;i < entries.length; i++) {
      const entry = entries[i];
      if (entry.length < 4)
        continue;
      paths.add(entry.slice(3));
      if (entry[0] === "R" || entry[0] === "C")
        i++;
    }
    return paths;
  }
  async discardPaths(paths) {
    if (paths.length === 0)
      return;
    const tracked = new Set((await this.git(this.dir, ["ls-files", "-z", "--", ...paths])).stdout.split("\x00").filter(Boolean));
    const restore = paths.filter((path) => tracked.has(path));
    const remove = paths.filter((path) => !tracked.has(path));
    if (restore.length > 0) {
      await this.git(this.dir, ["checkout", "--quiet", "--", ...restore]);
    }
    if (remove.length > 0) {
      await this.git(this.dir, ["clean", "--quiet", "-f", "--", ...remove]);
    }
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
