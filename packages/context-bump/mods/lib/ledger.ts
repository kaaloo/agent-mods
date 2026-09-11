// squad-mods shared memory integration: mount resolution, git sync, and the
// shared config file. The shared repo is attached to every squad agent and
// mounts at $MEMORY_DIR/../squad-mods as a normal git checkout. If the mount
// is missing (fresh environment), the mod clones it itself using the agent's
// git endpoint and configures the same credential helper the CLI uses.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { parseConfig } from "./config.ts";
import type { BumpConfig } from "./config.ts";

const execFileAsync = promisify(execFile);

export const REPO_NAME = "squad-mods";
const MOD_DIR = "context-bump";
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

export function configFile(mount: string): string {
  return path.join(mount, MOD_DIR, CONFIG_FILE);
}

function repositoryUrl(baseUrl: string, agentId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/git/${agentId}/repositories/${REPO_NAME}.git`;
}

async function git(cwd: string | null, args: string[], token?: string): Promise<{ ok: boolean; stderr: string }> {
  try {
    const options: { cwd?: string; maxBuffer?: number; timeout?: number; env?: NodeJS.ProcessEnv } = {
      maxBuffer: 10 * 1024 * 1024,
      // Never let a git operation hang the event handler: fail fast instead of
      // blocking on a network or credential read.
      timeout: 8000,
      env: {
        ...process.env,
        // Belt-and-suspenders non-interactive, in case the -c flags below are
        // not honored by a given git build.
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        SSH_ASKPASS: "/bin/false",
      },
    };
    if (cwd) options.cwd = cwd;
    // Force non-interactive via -c (more reliable than env for the
    // remote-helper path) and, when a token is available, authenticate every
    // call directly instead of relying on the repo's credential helper. The
    // helper is only configured on clones the mod created; pre-existing mounts
    // use an insteadof rewrite to a local backend that may be down at TUI
    // launch, which previously made git block on a keychain/TTY read and
    // wedge the host UI.
    const finalArgs = [
      "-c",
      "credential.interactive=false",
      "-c",
      "core.askpass=/bin/false",
      ...(token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : []),
      ...args,
    ];
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
 * no token) so callers fall back to built-in defaults.
 */
export async function ensureMount(
  memoryDir: string | null,
  agentId: string | null,
  baseUrl: string | null,
  token: string | null,
): Promise<MountInfo> {
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
  // Mirror the credential helper the CLI configures so future pulls work
  // without the token being passed on every invocation.
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
  await git(mount, ["config", "user.name", "context-bump"]);
  await git(mount, ["config", "commit.gpgsign", "false"]);
}

export async function pullMount(mount: string, token?: string | null): Promise<boolean> {
  const result = await git(mount, ["pull", "--rebase", "--autostash", "origin", "main"], token ?? undefined);
  return result.ok;
}

export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export interface LoadedConfig {
  config: BumpConfig;
  source: "shared" | "defaults";
  mount: string | null;
}

export async function loadConfig(mountInfo: MountInfo, token?: string | null): Promise<LoadedConfig> {
  if (mountInfo.available) {
    await pullMount(mountInfo.path, token);
  }
  const shared = mountInfo.available ? readJsonFile(configFile(mountInfo.path)) : null;
  if (mountInfo.available && shared !== null) {
    return { config: parseConfig(shared), source: "shared", mount: mountInfo.path };
  }
  return { config: parseConfig(null), source: "defaults", mount: mountInfo.path };
}
