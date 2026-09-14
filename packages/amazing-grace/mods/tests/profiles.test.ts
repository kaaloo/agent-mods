import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfiles, rungSettings } from "../lib/profiles.ts";
import type { ModelProfile } from "../lib/profiles.ts";
import type { LadderRung } from "../lib/ladder.ts";

const DIR = join(tmpdir(), "grace-profiles-test");

function write(file: unknown, location: "mods" | "root" = "mods"): void {
  const path = location === "mods" ? join(DIR, "mods", "model-profiles.json") : join(DIR, "model-profiles.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(file), "utf8");
}

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe("readProfiles", () => {
  it("returns an empty map without a memory dir or file", () => {
    expect(readProfiles(null)).toEqual({});
    expect(readProfiles(DIR)).toEqual({});
  });

  it("reads valid profiles and skips malformed entries", () => {
    write({
      version: 1,
      profiles: {
        "deepseek/deepseek-v4.1-flash": { contextWindow: 1048576, reasoningEffort: "high" },
        "lc-kimi-code/k3-256k": { contextWindow: 256000 },
        "bad/no-window": { reasoningEffort: "high" },
        "bad/non-numeric": { contextWindow: "lots" },
        "bad/zero": { contextWindow: 0 },
      },
    });
    const profiles = readProfiles(DIR);
    expect(Object.keys(profiles).sort()).toEqual(["deepseek/deepseek-v4.1-flash", "lc-kimi-code/k3-256k"]);
    expect(profiles["deepseek/deepseek-v4.1-flash"]).toEqual({ contextWindow: 1048576, reasoningEffort: "high" });
    expect(profiles["lc-kimi-code/k3-256k"]).toEqual({ contextWindow: 256000 });
  });

  it("rejects an invalid reasoning effort tier", () => {
    write({ profiles: { "a/b": { contextWindow: 1000, reasoningEffort: "ultra" } } });
    expect(readProfiles(DIR)).toEqual({ "a/b": { contextWindow: 1000 } });
  });

  it("returns an empty map on malformed JSON", () => {
    mkdirSync(join(DIR, "mods"), { recursive: true });
    writeFileSync(join(DIR, "mods", "model-profiles.json"), "{not json", "utf8");
    expect(readProfiles(DIR)).toEqual({});
  });

  it("returns an empty map when profiles is not an object", () => {
    write({ profiles: ["nope"] });
    expect(readProfiles(DIR)).toEqual({});
  });

  it("keeps using a legacy root-level file when the mods copy is absent", () => {
    write({ profiles: { "a/b": { contextWindow: 500000 } } }, "root");
    expect(readProfiles(DIR)).toEqual({ "a/b": { contextWindow: 500000 } });
  });

  it("prefers the mods copy when both locations exist", () => {
    write({ profiles: { "a/b": { contextWindow: 111111 } } }, "root");
    write({ profiles: { "a/b": { contextWindow: 222222 } } }, "mods");
    expect(readProfiles(DIR)).toEqual({ "a/b": { contextWindow: 222222 } });
  });
});

describe("rungSettings", () => {
  const profiles: Record<string, ModelProfile> = {
    "deepseek/deepseek-v4.1-flash": { contextWindow: 1048576, reasoningEffort: "high" },
    "lc-kimi-code/k3-256k": { contextWindow: 256000 },
  };

  it("applies the profile for the rung handle", () => {
    const rung: LadderRung = { handle: "deepseek/deepseek-v4.1-flash", multimodal: true };
    expect(rungSettings(rung, profiles)).toEqual({ contextWindow: 1048576, reasoningEffort: "high" });
  });

  it("rung config fields win over the profile file", () => {
    const rung: LadderRung = {
      handle: "deepseek/deepseek-v4.1-flash",
      multimodal: true,
      contextWindow: 512000,
      reasoningEffort: "medium",
    };
    expect(rungSettings(rung, profiles)).toEqual({ contextWindow: 512000, reasoningEffort: "medium" });
  });

  it("a rung override wins per field, not per rung", () => {
    const rung: LadderRung = { handle: "deepseek/deepseek-v4.1-flash", multimodal: true, contextWindow: 512000 };
    expect(rungSettings(rung, profiles)).toEqual({ contextWindow: 512000, reasoningEffort: "high" });
  });

  it("returns empty settings when nothing matches", () => {
    const rung: LadderRung = { handle: "unknown/model", multimodal: true };
    expect(rungSettings(rung, profiles)).toEqual({});
  });

  it("ignores an invalid rung reasoning effort and falls back to the profile", () => {
    const rung: LadderRung = { handle: "lc-kimi-code/k3-256k", multimodal: true, reasoningEffort: "ultra" };
    expect(rungSettings(rung, profiles)).toEqual({ contextWindow: 256000 });
  });
});
