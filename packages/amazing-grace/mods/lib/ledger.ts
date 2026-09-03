// squad-mods shared memory integration: mount resolution, git sync, and the
// per-agent ledger file. The shared repo is attached to every squad agent and
// mounts at $MEMORY_DIR/../squad-mods as a normal git checkout. If the mount
// is missing (fresh environment), the mod clones it itself using the agent's
// git endpoint and configures the same credential helper the CLI uses.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseConfig } from "./ladder.ts";
import type { GraceConfig } from "./ladder.ts";
import { parseState } from "./state.ts";
import type { AgentGraceState } from "./state.ts";

const execFileAsync = promisify(execFile);

export const REPO_NAME = "squad-mods";
const MOD_DIR = "amazing-grace";
const LEDGER_DIR = "ledger";
const CONFIG_FILE = "config.json";

export interface MountInfo {
  path: string;
  available: boolean;
  clonedByMod: boolean;
}

export function mountPath(memoryDir: string | null): string | null {
  if (!memoryDir) return null;
  return path.join(path.dirname(path.resolve(memoryDir)), REPO_NAME);
}

export function ledgerFile(mount: string, agentId: string): string {
  return path.join(mount, MOD_DIR, LEDGER_DIR, `${agentId}.json`);
}

export function configFile(mount: string): string {
  return path.join(mount, MOD_DIR, CONFIG_FILE);
}

function repositoryUrl(baseUrl: string, agentId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/git/${agentId}/repositories/${REPO_NAME}.git`;
}

async function git(cwd: string | null, args: string[], token?: string): Promise<{ ok: boolean; stderr: string }> {
  try {
    const options: { cwd?: string; maxBuffer?: number } = { maxBuffer: 10 * 1024 * 1024 };
    if (cwd) options.cwd = cwd;
    const finalArgs = token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...args] : args;
    await execFileAsync("git", finalArgs, options);
    return { ok: true, stderr: "" };
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    return { ok: false, stderr: (err.stderr || err.message || "git failed").slice(0, 500) };
  }
}

/**
 * Resolve the squad-mods mount. Uses the existing checkout when present;
 * clones one otherwise. Returns available=false when neither works (offline,
 * no token) so callers fall back to defaults plus the local cache.
 */
export async function ensureMount(memoryDir: string | null, agentId: string | null, baseUrl: string | null, token: string | null): Promise<MountInfo> {
  const mount = mountPath(memoryDir);
  if (!mount || !agentId) return { path: mount ?? REPO_NAME, available: false, clonedByMod: false };
  if (existsSync(path.join(mount, ".git"))) {
    return { path: mount, available: true, clonedByMod: false };
  }
  if (!baseUrl || !token) return { path: mount, available: false, clonedByMod: false };
  mkdirSync(path.dirname(mount), { recursive: true });
  const url = repositoryUrl(baseUrl, agentId);
  const clone = await git(path.dirname(mount), ["clone", url, mount], token);
  if (!clone.ok) return { path: mount, available: false, clonedByMod: false };
  // Mirror the credential helper the CLI configures so future pulls/pushes
  // work without the token being passed on every invocation.
  await configureCredentialHelper(mount, baseUrl, token, agentId);
  return { path: mount, available: true, clonedByMod: true };
}

async function configureCredentialHelper(mount: string, baseUrl: string, token: string, agentId: string): Promise<void> {
  const host = new URL(baseUrl).host;
  await git(mount, ["config", `credential.https://${host}.helper`, ""]);
  await git(mount, [
    "config",
    "--add",
    `credential.https://${host}.helper`,
    `!f() { echo "username=letta"; echo "password=${token}"; }; f`,
  ]);
  await git(mount, ["config", "letta.agentId", agentId]);
  // Identity and signing for commits made by the mod on fresh clones; the
  // CLI-configured mounts already carry these.
  await git(mount, ["config", "user.email", `${agentId}@letta.com`]);
  await git(mount, ["config", "user.name", "amazing-grace"]);
  await git(mount, ["config", "commit.gpgsign", "false"]);
}

export async function pullMount(mount: string): Promise<boolean> {
  const result = await git(mount, ["pull", "--rebase", "--autostash", "origin", "main"]);
  return result.ok;
}

export interface PushResult {
  committed: boolean;
  pushed: boolean;
  error?: string;
}

export async function commitAndPush(mount: string, files: string[], message: string): Promise<PushResult> {
  if (files.length === 0) return { committed: false, pushed: false };
  const add = await git(mount, ["add", "--", ...files]);
  if (!add.ok) return { committed: false, pushed: false, error: add.stderr };
  // Only commit when there is something staged; otherwise this is a no-op.
  const status = await git(mount, ["diff", "--cached", "--quiet"]);
  if (status.ok) return { committed: false, pushed: false };
  const commit = await git(mount, [
    "commit",
    "-m",
    `${message}\n\n👾 Generated with [Letta Code](https://letta.com)\n\nCo-Authored-By: Letta Code <noreply@letta.com>`,
  ]);
  if (!commit.ok) return { committed: false, pushed: false, error: commit.stderr };
  const push = await git(mount, ["push", "origin", "main"]);
  if (push.ok) return { committed: true, pushed: true };
  // Another agent pushed concurrently: rebase our commit on top and retry once.
  const rebase = await git(mount, ["pull", "--rebase", "--autostash", "origin", "main"]);
  if (!rebase.ok) return { committed: true, pushed: false, error: push.stderr };
  const retry = await git(mount, ["push", "origin", "main"]);
  return retry.ok
    ? { committed: true, pushed: true }
    : { committed: true, pushed: false, error: retry.stderr };
}

export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export interface LoadedContext {
  config: GraceConfig;
  state: AgentGraceState;
  source: "shared" | "cache" | "defaults";
  mount: string | null;
}

// Machine-local cache so a fresh session works when the shared repo is
// unreachable. Deliberately outside MemFS: it is a transport cache, not memory.
export function cacheFile(agentId: string): string {
  return path.join(os.homedir(), ".letta", "mods", "state", "amazing-grace", `${agentId}.json`);
}

export async function loadContext(mountInfo: MountInfo, agentId: string): Promise<LoadedContext> {
  if (mountInfo.available) {
    await pullMount(mountInfo.path);
  }
  const sharedConfig = mountInfo.available ? readJsonFile(configFile(mountInfo.path)) : null;
  const sharedState = mountInfo.available ? readJsonFile(ledgerFile(mountInfo.path, agentId)) : null;
  if (mountInfo.available && sharedConfig) {
    return {
      config: parseConfig(sharedConfig),
      state: parseState(sharedState, agentId),
      source: "shared",
      mount: mountInfo.path,
    };
  }
  const cached = readJsonFile(cacheFile(agentId));
  if (cached) {
    return {
      config: parseConfig((cached as Record<string, unknown>).config ?? null),
      state: parseState((cached as Record<string, unknown>).state ?? null, agentId),
      source: "cache",
      mount: mountInfo.path,
    };
  }
  return {
    config: parseConfig(null),
    state: parseState(null, agentId),
    source: "defaults",
    mount: mountInfo.path,
  };
}

export async function saveState(mountInfo: MountInfo, agentId: string, state: AgentGraceState, config: GraceConfig, eventSummary: string): Promise<PushResult> {
  state.updatedAt = new Date().toISOString();
  // Always refresh the local cache (state plus the config it was decided with).
  const cache = cacheFile(agentId);
  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify({ state, config, updatedAt: state.updatedAt }, null, 2));
  if (!mountInfo.available) return { committed: false, pushed: false, error: "mount unavailable" };
  const file = ledgerFile(mountInfo.path, agentId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
  return commitAndPush(mountInfo.path, [path.relative(mountInfo.path, file)], `amazing-grace: ${eventSummary}`);
}
