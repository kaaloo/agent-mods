import { describe, expect, it } from "vitest";
import { buildRaisePatch } from "../lib/limits.ts";
import type { CurrentLimits } from "../lib/limits.ts";

const target = { contextWindow: 256000, maxOutputTokens: 65536 };

function current(contextWindow: number | null, maxOutputTokens: number | null): CurrentLimits {
  return { contextWindow, maxOutputTokens };
}

describe("buildRaisePatch", () => {
  it("raises both fields when below target", () => {
    expect(buildRaisePatch(current(128000, 16384), target)).toEqual({
      context_window_limit: 256000,
      model_settings: { max_output_tokens: 65536 },
    });
  });

  it("raises only the fields below target", () => {
    expect(buildRaisePatch(current(512000, 16384), target)).toEqual({
      model_settings: { max_output_tokens: 65536 },
    });
  });

  it("returns null when already at or above target", () => {
    expect(buildRaisePatch(current(256000, 65536), target)).toBeNull();
    expect(buildRaisePatch(current(512000, 131072), target)).toBeNull();
  });

  it("leaves inherited null values alone", () => {
    expect(buildRaisePatch(current(null, null), target)).toBeNull();
    expect(buildRaisePatch(current(null, 16384), target)).toEqual({
      model_settings: { max_output_tokens: 65536 },
    });
  });
});
