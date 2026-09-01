import { describe, expect, it } from "vitest";
import {
  activeCooldowns,
  appendEvent,
  changeKind,
  emptyState,
  expiredCooldowns,
  markCooldown,
  markDead,
  parseState,
  pruneCooldowns,
  revive,
} from "../lib/state.ts";

const NOW = 1_700_000_000_000;
const ISO = new Date(NOW).toISOString();

describe("parseState", () => {
  it("returns an empty state for junk input", () => {
    const state = parseState(null, "agent-x");
    expect(state.agentId).toBe("agent-x");
    expect(state.paused).toBe(false);
    expect(state.pinned).toBe(null);
    expect(state.events).toEqual([]);
  });

  it("round-trips persisted fields, dropping malformed ones", () => {
    const state = parseState(
      {
        paused: true,
        pinned: "a/b",
        cooldowns: { "a/b": ISO, broken: "not-a-date" },
        dead: ["c/d", 42],
        events: [{ ts: ISO, kind: "downgrade", from: "a/b", to: "c/d", reason: "quota" }, { bad: true }],
      },
      "agent-x",
    );
    expect(state.paused).toBe(true);
    expect(state.pinned).toBe("a/b");
    expect(Object.keys(state.cooldowns)).toEqual(["a/b"]);
    expect(state.dead).toEqual(["c/d"]);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ kind: "downgrade", reason: "quota" });
  });
});

describe("cooldown bookkeeping", () => {
  it("exposes only active cooldowns", () => {
    const state = emptyState("agent-x");
    markCooldown(state, "a/b", 60, NOW);
    // Started 61 minutes ago with a 60-minute window: already expired.
    markCooldown(state, "c/d", 60, NOW - 61 * 60_000);
    expect(Object.keys(activeCooldowns(state, NOW))).toEqual(["a/b"]);
  });

  it("prunes expired entries on write", () => {
    const state = emptyState("agent-x");
    markCooldown(state, "a/b", 60, NOW - 61 * 60_000);
    expect(pruneCooldowns(state, NOW)).toBe(true);
    expect(state.cooldowns).toEqual({});
    expect(pruneCooldowns(state, NOW)).toBe(false);
  });

  it("reports expired cooldowns for recovery probing", () => {
    const state = emptyState("agent-x");
    markCooldown(state, "a/b", 60, NOW);
    markCooldown(state, "c/d", 60, NOW - 61 * 60_000);
    state.cooldowns.broken = "not-a-date";
    expect(expiredCooldowns(state, NOW)).toEqual(["c/d", "broken"]);
  });
});

describe("dead bookkeeping", () => {
  it("marks dead once and revives cleanly", () => {
    const state = emptyState("agent-x");
    markDead(state, "a/b");
    markDead(state, "a/b");
    expect(state.dead).toEqual(["a/b"]);
    markCooldown(state, "a/b", 60, NOW);
    expect(revive(state, "a/b")).toBe(true);
    expect(state.dead).toEqual([]);
    expect(state.cooldowns).toEqual({});
    expect(revive(state, "a/b")).toBe(false);
  });
});

describe("appendEvent", () => {
  it("caps the event log at 500 entries", () => {
    const state = emptyState("agent-x");
    for (let i = 0; i < 520; i += 1) {
      appendEvent(state, { ts: new Date(NOW + i).toISOString(), kind: "probe", from: null, to: null, reason: "manual" });
    }
    expect(state.events).toHaveLength(500);
    expect(state.events.at(-1)?.reason).toBe("manual");
    expect(state.updatedAt).toBe(new Date(NOW + 519).toISOString());
  });
});

describe("changeKind", () => {
  it("names direction and enforcement", () => {
    expect(changeKind(0, 2, false)).toBe("downgrade");
    expect(changeKind(3, 1, false)).toBe("upgrade");
    expect(changeKind(-1, 0, false)).toBe("config-change");
    expect(changeKind(0, 1, true)).toBe("image-downgrade");
  });
});
