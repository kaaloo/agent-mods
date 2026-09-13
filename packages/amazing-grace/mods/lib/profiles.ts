// Per-model settings applied on ladder switches.
//
// Reads the profile file written by @letta-ai/model-profiles
// ($MEMORY_DIR/mods/model-profiles.json) so a rung switch restores the saved
// context window and reasoning effort instead of the model's catalog
// defaults. Ladder rungs may also carry contextWindow/reasoningEffort in
// squad config; those win over the profile file.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LadderRung } from "./ladder.ts";

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface RungSettings {
  contextWindow?: number;
  reasoningEffort?: ReasoningEffort;
}

export interface ModelProfile {
  contextWindow: number;
  reasoningEffort?: ReasoningEffort;
  label?: string;
  updatedAt?: string;
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

function isProfile(value: unknown): value is ModelProfile {
  if (typeof value !== "object" || value === null) return false;
  const contextWindow = (value as ModelProfile).contextWindow;
  return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0;
}

function profilesPath(memoryDir: string): string {
  // model-profiles keeps a legacy root-level file in place; prefer the
  // current location when both exist.
  const inMods = join(memoryDir, "mods", "model-profiles.json");
  const inRoot = join(memoryDir, "model-profiles.json");
  if (existsSync(inRoot) && !existsSync(inMods)) return inRoot;
  return inMods;
}

/**
 * Read the model-profiles file. Missing or malformed files yield an empty
 * map: a rung switch then falls back to the current behavior (model and
 * scope only) instead of failing.
 */
export function readProfiles(memoryDir: string | null): Record<string, ModelProfile> {
  if (!memoryDir) return {};
  const path = profilesPath(memoryDir);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return {};
    const profiles = (raw as { profiles?: unknown }).profiles;
    if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) return {};
    const result: Record<string, ModelProfile> = {};
    for (const [handle, value] of Object.entries(profiles as Record<string, unknown>)) {
      if (!isProfile(value)) continue;
      result[handle] = {
        contextWindow: Math.floor(value.contextWindow),
        ...(isReasoningEffort(value.reasoningEffort) ? { reasoningEffort: value.reasoningEffort } : {}),
      };
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Settings to apply when switching onto a rung: rung fields from squad
 * config win over the model-profiles file; both are optional.
 */
export function rungSettings(rung: LadderRung, profiles: Record<string, ModelProfile>): RungSettings {
  const profile = profiles[rung.handle];
  const contextWindow =
    typeof rung.contextWindow === "number" && Number.isFinite(rung.contextWindow) && rung.contextWindow > 0
      ? Math.floor(rung.contextWindow)
      : profile?.contextWindow;
  const reasoningEffort = isReasoningEffort(rung.reasoningEffort)
    ? rung.reasoningEffort
    : profile?.reasoningEffort;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
}
