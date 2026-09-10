import { describe, expect, it } from "vitest";
import { parseConfig, resolveTarget } from "../lib/config.ts";

describe("parseConfig", () => {
  it("returns defaults for null input", () => {
    const config = parseConfig(null);
    expect(config.default).toEqual({ contextWindow: 256000, maxOutputTokens: 65536 });
    expect(config.models).toEqual({});
    expect(config.agents).toEqual({});
  });

  it("applies default overrides", () => {
    const config = parseConfig({ default: { contextWindow: 300000, maxOutputTokens: 100000 } });
    expect(config.default.contextWindow).toBe(300000);
    expect(config.default.maxOutputTokens).toBe(100000);
  });

  it("parses per-model and per-agent overrides", () => {
    const config = parseConfig({
      models: { "lc-deepseek/deepseek-v4-flash": { contextWindow: 512000 } },
      agents: { "agent-1": { maxOutputTokens: 131072 } },
    });
    expect(config.models["lc-deepseek/deepseek-v4-flash"]).toEqual({ contextWindow: 512000 });
    expect(config.agents["agent-1"]).toEqual({ maxOutputTokens: 131072 });
  });

  it("ignores invalid entries", () => {
    const config = parseConfig({
      default: { contextWindow: -1, maxOutputTokens: "nope" },
      models: { "": { contextWindow: 100 }, bad: "x" },
    });
    expect(config.default.contextWindow).toBe(256000);
    expect(config.default.maxOutputTokens).toBe(65536);
    expect(config.models[""]).toBeUndefined();
    expect(config.models.bad).toBeUndefined();
  });
});

describe("resolveTarget", () => {
  const config = parseConfig({
    default: { contextWindow: 256000, maxOutputTokens: 65536 },
    models: { m1: { contextWindow: 512000 } },
    agents: { a1: { maxOutputTokens: 131072 } },
  });

  it("falls back to defaults", () => {
    expect(resolveTarget(config, "m2", "a2")).toEqual({ contextWindow: 256000, maxOutputTokens: 65536 });
  });

  it("applies a model override above the default", () => {
    expect(resolveTarget(config, "m1", "a2")).toEqual({ contextWindow: 512000, maxOutputTokens: 65536 });
  });

  it("applies an agent override above model and default", () => {
    expect(resolveTarget(config, "m1", "a1")).toEqual({ contextWindow: 512000, maxOutputTokens: 131072 });
  });

  it("treats null model and agent as default", () => {
    expect(resolveTarget(config, null, null)).toEqual({ contextWindow: 256000, maxOutputTokens: 65536 });
  });
});
