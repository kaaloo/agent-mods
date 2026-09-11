// Local state cache for the bump indicator. The statusline mod reads this to
// render a compact "context was auto-raised" marker, so the bump itself needs
// no panel row of its own. Mirrors the amazing-grace state-cache pattern:
// keyed by agent, entries per conversation, best-effort writes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const MOD = "context-bump";
const MAX_ENTRIES = 25;

export interface BumpEntry {
  /** True when the mod raised this conversation's context window. */
  bumped: boolean;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  at: string;
}

interface StateFile {
  conversations: Record<string, BumpEntry>;
}

export function stateFile(agentId: string): string {
  return path.join(homedir(), ".letta", "mods", "state", MOD, `${agentId}.json`);
}

function read(agentId: string): StateFile {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(agentId), "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StateFile).conversations === "object" &&
      (parsed as StateFile).conversations !== null
    ) {
      return { conversations: (parsed as StateFile).conversations };
    }
  } catch {
    // missing or unreadable: start fresh
  }
  return { conversations: {} };
}

export function writeBumpState(agentId: string, conversationId: string, entry: BumpEntry): void {
  try {
    const state = read(agentId);
    state.conversations[conversationId] = entry;
    // Keep the file bounded by dropping the oldest entries.
    const ids = Object.keys(state.conversations);
    if (ids.length > MAX_ENTRIES) {
      ids
        .sort((a, b) => Date.parse(state.conversations[a].at) - Date.parse(state.conversations[b].at))
        .slice(0, ids.length - MAX_ENTRIES)
        .forEach((id) => {
          delete state.conversations[id];
        });
    }
    const file = stateFile(agentId);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2));
  } catch {
    // Best-effort: never block the bump on state bookkeeping.
  }
}
