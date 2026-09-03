import { describe, expect, it } from "vitest";
import { DEFAULT_LADDER, defaultConfig, findRung, parseConfig, targetRung } from "../lib/ladder.ts";

const NOW = 1_700_000_000_000;

describe("parseConfig", () => {
  it("returns defaults for null input", () => {
    const config = parseConfig(null);
    expect(config.ladder).toEqual(DEFAULT_LADDER);
    expect(config.cooldownMinutes).toBe(60);
    expect(config.autoContinue).toBe(true);
    expect(config.enforceLadder).toBe(true);
  });

  it("accepts a full shared config", () => {
    const config = parseConfig({
      ladder: [{ handle: "a/b" }, { handle: "c/d", multimodal: false }],
      cooldownMinutes: 30,
      autoContinue: false,
      probeEnabled: false,
      enforceLadder: false,
    });
    expect(config.ladder).toEqual([
      { handle: "a/b", multimodal: true },
      { handle: "c/d", multimodal: false },
    ]);
    expect(config.cooldownMinutes).toBe(30);
    expect(config.autoContinue).toBe(false);
    expect(config.enforceLadder).toBe(false);
  });

  it("falls back to the default ladder for malformed ladders", () => {
    const config = parseConfig({ ladder: [{ handle: "" }, "nope", 3] });
    expect(config.ladder).toEqual(DEFAULT_LADDER);
  });

  it("rejects non-positive cooldown values", () => {
    expect(parseConfig({ cooldownMinutes: 0 }).cooldownMinutes).toBe(60);
    expect(parseConfig({ cooldownMinutes: -5 }).cooldownMinutes).toBe(60);
  });
});

describe("findRung", () => {
  it("finds by handle and returns -1 for unknown or null", () => {
    const ladder = defaultConfig().ladder;
    expect(findRung(ladder, "lc-zai-coding/glm-5.3")).toBe(0);
    expect(findRung(ladder, "lc-kimi-code/k3")).toBe(4);
    expect(findRung(ladder, "letta/auto")).toBe(-1);
    expect(findRung(ladder, null)).toBe(-1);
  });
});

describe("targetRung", () => {
  it("returns the top rung when nothing is benched", () => {
    const config = defaultConfig();
    expect(targetRung(config, {}, [], NOW, false)?.handle).toBe("lc-zai-coding/glm-5.3");
  });

  it("skips rungs that are cooling down", () => {
    const config = defaultConfig();
    const cooldowns = { "lc-zai-coding/glm-5.3": NOW + 60_000 };
    expect(targetRung(config, cooldowns, [], NOW, false)?.handle).toBe("lc-qwen-code/qwen3.8-max");
  });

  it("treats expired cooldowns as eligible", () => {
    const config = defaultConfig();
    const cooldowns = { "lc-zai-coding/glm-5.3": NOW - 1 };
    expect(targetRung(config, cooldowns, [], NOW, false)?.handle).toBe("lc-zai-coding/glm-5.3");
  });

  it("skips dead rungs", () => {
    const config = defaultConfig();
    expect(targetRung(config, {}, ["lc-zai-coding/glm-5.3"], NOW, false)?.handle).toBe("lc-qwen-code/qwen3.8-max");
  });

  it("falls back to the last rung when everything is benched", () => {
    const config = defaultConfig();
    const dead = config.ladder.map((r) => r.handle).slice(0, -1);
    expect(targetRung(config, {}, dead, NOW, false)?.handle).toBe("lc-kimi-code/k3");
  });

  it("advances to the first multimodal rung for image turns", () => {
    const config = defaultConfig();
    expect(targetRung(config, {}, [], NOW, true)?.handle).toBe("lc-qwen-code/qwen3.8-max");
  });

  it("keeps position when already multimodal", () => {
    const config = defaultConfig();
    const cooldowns = { "lc-zai-coding/glm-5.3": NOW + 60_000, "lc-qwen-code/qwen3.8-max": NOW + 60_000 };
    expect(targetRung(config, cooldowns, [], NOW, true)?.handle).toBe("lc-codex/gpt-5.6-sol");
  });

  it("never goes below the selected position for images", () => {
    const config = parseConfig({ ladder: [{ handle: "text-only", multimodal: false }, { handle: "vision", multimodal: true }] });
    expect(targetRung(config, { "text-only": NOW + 60_000 }, [], NOW, true)?.handle).toBe("vision");
  });
});
