// Ladder configuration, parsing, and rung evaluation.
// Shared squad config lives at squad-mods/amazing-grace/config.json; the
// defaults below are the fallback when no shared config is reachable.

export interface LadderRung {
  handle: string;
  multimodal: boolean;
}

export interface GraceConfig {
  ladder: LadderRung[];
  cooldownMinutes: number;
  autoContinue: boolean;
  probeEnabled: boolean;
  enforceLadder: boolean;
}

export const DEFAULT_LADDER: LadderRung[] = [
  { handle: "lc-zai-coding/glm-5.3", multimodal: false },
  { handle: "lc-qwen-code/qwen3.8-max", multimodal: true },
  { handle: "lc-codex/gpt-5.6-sol", multimodal: true },
  { handle: "lc-minimax/MiniMax-M3", multimodal: true },
  { handle: "lc-kimi-code/k3", multimodal: true },
];

export function defaultConfig(): GraceConfig {
  return {
    ladder: DEFAULT_LADDER.map((r) => ({ ...r })),
    cooldownMinutes: 60,
    autoContinue: true,
    probeEnabled: true,
    enforceLadder: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLadder(raw: unknown): LadderRung[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const rungs: LadderRung[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const handle = item.handle;
    if (typeof handle !== "string" || !handle.trim()) return null;
    rungs.push({ handle: handle.trim(), multimodal: item.multimodal !== false });
  }
  return rungs;
}

export function parseConfig(raw: unknown): GraceConfig {
  const config = defaultConfig();
  if (!isRecord(raw)) return config;
  const ladder = parseLadder(raw.ladder);
  if (ladder) config.ladder = ladder;
  if (typeof raw.cooldownMinutes === "number" && raw.cooldownMinutes > 0) {
    config.cooldownMinutes = raw.cooldownMinutes;
  }
  if (typeof raw.autoContinue === "boolean") config.autoContinue = raw.autoContinue;
  if (typeof raw.probeEnabled === "boolean") config.probeEnabled = raw.probeEnabled;
  if (typeof raw.enforceLadder === "boolean") config.enforceLadder = raw.enforceLadder;
  return config;
}

export function findRung(ladder: LadderRung[], handle: string | null | undefined): number {
  if (!handle) return -1;
  return ladder.findIndex((r) => handlesMatch(r.handle, handle));
}

export function handlesMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  return (left === "auto" && right === "letta/auto") || (left === "letta/auto" && right === "auto");
}

export function canonicalRungHandle(ladder: LadderRung[], handle: string): string {
  const index = findRung(ladder, handle);
  return index >= 0 ? ladder[index].handle : handle;
}

/**
 * Pick the rung the agent should be on right now.
 *
 * Walks from the top, skipping rungs that are marked dead or still cooling
 * down. If every rung is benched, falls back to the last rung (best effort).
 * When the turn needs multimodal support, advances to the first multimodal
 * rung at or below the selected position.
 */
export function targetRung(
  config: GraceConfig,
  cooldowns: Record<string, number>,
  dead: string[],
  now: number,
  needsMultimodal: boolean,
): LadderRung | null {
  const ladder = config.ladder;
  if (ladder.length === 0) return null;
  let i = 0;
  while (i < ladder.length) {
    const handle = ladder[i].handle;
    if (dead.includes(handle)) {
      i += 1;
      continue;
    }
    const until = cooldowns[handle];
    if (typeof until === "number" && until > now) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= ladder.length) i = ladder.length - 1;
  if (needsMultimodal) {
    let j = i;
    while (j < ladder.length && !ladder[j].multimodal) j += 1;
    if (j < ladder.length) return ladder[j];
    return ladder[i];
  }
  return ladder[i];
}
