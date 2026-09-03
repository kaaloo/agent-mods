// Per-agent grace state: bench bookkeeping plus the event log that is shared
// with the squad via the squad-mods shared memory repository.

// Ladder types are imported by the runtime; state itself is ladder-agnostic.

export const MAX_EVENTS = 500;

export interface GraceEvent {
  ts: string;
  kind:
    | "downgrade"
    | "upgrade"
    | "image-downgrade"
    | "probe"
    | "dead-mark"
    | "recover"
    | "config-change";
  from: string | null;
  to: string | null;
  reason: string;
  detail?: string;
  conversationId?: string | null;
}

export interface AgentGraceState {
  agentId: string;
  updatedAt: string;
  paused: boolean;
  pinned: string | null;
  cooldowns: Record<string, string>;
  dead: string[];
  events: GraceEvent[];
}

export function emptyState(agentId: string): AgentGraceState {
  return {
    agentId,
    updatedAt: new Date(0).toISOString(),
    paused: false,
    pinned: null,
    cooldowns: {},
    dead: [],
    events: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseState(raw: unknown, agentId: string): AgentGraceState {
  const state = emptyState(agentId);
  if (!isRecord(raw)) return state;
  if (typeof raw.paused === "boolean") state.paused = raw.paused;
  if (typeof raw.pinned === "string" && raw.pinned.trim()) state.pinned = raw.pinned.trim();
  if (isRecord(raw.cooldowns)) {
    for (const [handle, until] of Object.entries(raw.cooldowns)) {
      if (typeof until === "string" && !Number.isNaN(Date.parse(until))) {
        state.cooldowns[handle] = until;
      }
    }
  }
  if (Array.isArray(raw.dead)) {
    state.dead = raw.dead.filter((h): h is string => typeof h === "string");
  }
  if (Array.isArray(raw.events)) {
    for (const item of raw.events) {
      if (!isRecord(item)) continue;
      if (typeof item.ts !== "string" || typeof item.kind !== "string") continue;
      state.events.push({
        ts: item.ts,
        kind: item.kind as GraceEvent["kind"],
        from: typeof item.from === "string" ? item.from : null,
        to: typeof item.to === "string" ? item.to : null,
        reason: typeof item.reason === "string" ? item.reason : "unknown",
        detail: typeof item.detail === "string" ? item.detail : undefined,
        conversationId: typeof item.conversationId === "string" ? item.conversationId : null,
      });
    }
  }
  return state;
}

export function appendEvent(state: AgentGraceState, event: GraceEvent): void {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  state.updatedAt = event.ts;
}

export function activeCooldowns(state: AgentGraceState, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [handle, until] of Object.entries(state.cooldowns)) {
    const t = Date.parse(until);
    if (!Number.isNaN(t) && t > now) out[handle] = t;
  }
  return out;
}

export function pruneCooldowns(state: AgentGraceState, now: number): boolean {
  let changed = false;
  for (const [handle, until] of Object.entries(state.cooldowns)) {
    const t = Date.parse(until);
    if (Number.isNaN(t) || t <= now) {
      delete state.cooldowns[handle];
      changed = true;
    }
  }
  return changed;
}

// Handles whose cooldown has expired (or is unparseable) as of `now`.
// Recovery probes should run for exactly these rungs, not for rungs still
// inside their cooldown window.
export function expiredCooldowns(state: AgentGraceState, now: number): string[] {
  const out: string[] = [];
  for (const [handle, until] of Object.entries(state.cooldowns)) {
    const t = Date.parse(until);
    if (Number.isNaN(t) || t <= now) out.push(handle);
  }
  return out;
}

export function markCooldown(state: AgentGraceState, handle: string, minutes: number, now: number): void {
  state.cooldowns[handle] = new Date(now + minutes * 60_000).toISOString();
}

export function markDead(state: AgentGraceState, handle: string): void {
  if (!state.dead.includes(handle)) state.dead.push(handle);
}

export function revive(state: AgentGraceState, handle: string): boolean {
  let changed = false;
  if (state.dead.includes(handle)) {
    state.dead = state.dead.filter((h) => h !== handle);
    changed = true;
  }
  if (state.cooldowns[handle]) {
    delete state.cooldowns[handle];
    changed = true;
  }
  return changed;
}

// Direction of a model change between two ladder positions, for event naming.
// A move starting outside the ladder (e.g. a router handle) is enforcement.
export function changeKind(fromIndex: number, toIndex: number, needsMultimodal: boolean): GraceEvent["kind"] {
  if (needsMultimodal) return "image-downgrade";
  if (fromIndex < 0) return "config-change";
  return toIndex > fromIndex ? "downgrade" : "upgrade";
}
