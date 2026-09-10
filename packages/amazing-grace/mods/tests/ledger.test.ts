import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { configFile, ledgerFile, mountPath, readJsonFile } from "../lib/ledger.ts";
import { defaultConfig } from "../lib/ladder.ts";
import { emptyState } from "../lib/state.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "amazing-grace-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("mountPath", () => {
  it("derives the sibling of the memory dir", () => {
    expect(mountPath("/home/agent/memory")).toBe(path.join("/home/agent", "squad-mods"));
    expect(mountPath(null)).toBe(null);
  });
});

describe("paths", () => {
  it("places config and per-agent ledger under amazing-grace/", () => {
    expect(configFile("/m")).toBe(path.join("/m", "amazing-grace", "config.json"));
    expect(ledgerFile("/m", "agent-1")).toBe(path.join("/m", "amazing-grace", "ledger", "agent-1.json"));
  });
});

describe("readJsonFile", () => {
  it("parses valid JSON and tolerates missing or broken files", () => {
    const dir = makeTempDir();
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ ok: true }));
    expect(readJsonFile(good)).toEqual({ ok: true });
    expect(readJsonFile(path.join(dir, "missing.json"))).toBe(null);
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(readJsonFile(bad)).toBe(null);
  });
});

describe("commitAndPush on a local origin", () => {
  function initRemote(dir: string): string {
    const origin = path.join(dir, "origin.git");
    execFileSync("git", ["init", "--bare", "-b", "main", origin]);
    return origin;
  }

  function initClone(dir: string, origin: string): string {
    const mount = path.join(dir, "mount");
    execFileSync("git", ["clone", origin, mount]);
    execFileSync("git", ["-C", mount, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", mount, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", mount, "config", "commit.gpgsign", "false"]);
    // Establish an initial commit on main so later commits have a base.
    writeFileSync(path.join(mount, "README.md"), "# init\n");
    execFileSync("git", ["-C", mount, "add", "README.md"]);
    execFileSync("git", ["-C", mount, "commit", "-m", "init"]);
    execFileSync("git", ["-C", mount, "push", "origin", "main"]);
    return mount;
  }

  it("commits ledger changes and pushes to origin", async () => {
    const { commitAndPush } = await import("../lib/ledger.ts");
    const dir = makeTempDir();
    const origin = initRemote(dir);
    const mount = initClone(dir, origin);
    const file = ledgerFile(mount, "agent-1");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ agentId: "agent-1" }));
    const result = await commitAndPush(mount, [path.relative(mount, file)], "test event");
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    // The remote has the file.
    const listing = execFileSync("git", ["--git-dir", origin, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" });
    expect(listing).toContain("amazing-grace/ledger/agent-1.json");
  });

  it("rebases over a concurrent push from another clone", async () => {
    const { commitAndPush, pullMount } = await import("../lib/ledger.ts");
    const dir = makeTempDir();
    const origin = initRemote(dir);
    const mountA = initClone(dir, origin);
    const mountB = path.join(dir, "mount-b");
    execFileSync("git", ["clone", origin, mountB]);
    execFileSync("git", ["-C", mountB, "config", "user.email", "b@example.com"]);
    execFileSync("git", ["-C", mountB, "config", "user.name", "B"]);
    execFileSync("git", ["-C", mountB, "config", "commit.gpgsign", "false"]);

    // B pushes a different file first; A then commits and must rebase over it.
    const fileB = ledgerFile(mountB, "agent-2");
    mkdirSync(path.dirname(fileB), { recursive: true });
    writeFileSync(fileB, JSON.stringify({ agentId: "agent-2" }));
    await commitAndPush(mountB, [path.relative(mountB, fileB)], "b event");

    const fileA = ledgerFile(mountA, "agent-1");
    mkdirSync(path.dirname(fileA), { recursive: true });
    writeFileSync(fileA, JSON.stringify({ agentId: "agent-1" }));
    const result = await commitAndPush(mountA, [path.relative(mountA, fileA)], "a event");
    expect(result.pushed).toBe(true);

    // Both files now exist on the remote.
    const listing = execFileSync("git", ["--git-dir", origin, "ls-tree", "-r", "--name-only", "main"], { encoding: "utf8" });
    expect(listing).toContain("amazing-grace/ledger/agent-1.json");
    expect(listing).toContain("amazing-grace/ledger/agent-2.json");

    // A stale clone pulls cleanly after the fact.
    expect(await pullMount(mountB)).toBe(true);
  });

  it("reports a no-op when nothing changed", async () => {
    const { commitAndPush } = await import("../lib/ledger.ts");
    const dir = makeTempDir();
    const origin = initRemote(dir);
    const mount = initClone(dir, origin);
    const result = await commitAndPush(mount, ["README.md"], "nothing new");
    expect(result.committed).toBe(false);
  });
});

describe("saveState cache coordination", () => {
  const realHomedir = os.homedir;

  afterEach(() => {
    os.homedir = realHomedir;
  });

  async function withTempHome(fn: () => Promise<void>): Promise<void> {
    const home = makeTempDir();
    os.homedir = () => home;
    try {
      await fn();
    } finally {
      os.homedir = realHomedir;
    }
  }

  it("preserves the renderedByStatusline marker across cache refreshes", async () => {
    await withTempHome(async () => {
      const { cacheFile, saveState, statuslineRendersGrace } = await import("../lib/ledger.ts");
      const agentId = "agent-marker";
      const cache = cacheFile(agentId);
      mkdirSync(path.dirname(cache), { recursive: true });
      // A statusline mod following the marker contract wrote this key.
      writeFileSync(cache, JSON.stringify({ renderedByStatusline: true }));

      const state = emptyState(agentId);
      const mount = { path: "/nonexistent-mount", available: false, clonedByMod: false };
      await saveState(mount, agentId, state, defaultConfig(), "test event");

      const after = readJsonFile(cache) as Record<string, unknown>;
      expect(after.renderedByStatusline).toBe(true);
      expect(statuslineRendersGrace(agentId)).toBe(true);
      // state and config were refreshed, not discarded.
      expect((after.state as Record<string, unknown>).agentId).toBe(agentId);
      expect(after.config).toBeDefined();
    });
  });

  it("reports false when no statusline marker exists", async () => {
    await withTempHome(async () => {
      const { saveState, statuslineRendersGrace } = await import("../lib/ledger.ts");
      const agentId = "agent-nomarker";
      const mount = { path: "/nonexistent-mount", available: false, clonedByMod: false };
      await saveState(mount, agentId, emptyState(agentId), defaultConfig(), "test event");
      expect(statuslineRendersGrace(agentId)).toBe(false);
    });
  });
});
