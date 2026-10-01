import { describe, expect, it } from "vitest";
import {
  canRetryProviderErrorWith,
  providerErrorText,
} from "../lib/provider-error.ts";
import type { ModProviderErrorEvent } from "../types.ts";

const event: ModProviderErrorEvent = {
  agentId: "agent-1",
  conversationId: "conv-1",
  phase: "post_stream",
  model: "google_ai/gemini-3.8-flash",
  provider: "google_ai",
  runId: "run-1",
  stopReason: "llm_api_error",
  error: {
    message: "Too many requests",
    detail: "Please retry in 4.154791243s",
    errorType: "llm_error",
    status: 429,
    retryable: true,
  },
  attempt: 4,
  maxAttempts: 4,
  failoverAttempt: 1,
  maxFailoverAttempts: 1,
  retryAfterMs: 4155,
  triedModels: ["google_ai/gemini-3.8-flash", "lc-zai-coding/glm-5.3"],
};

describe("provider-error recovery", () => {
  it("combines normalized provider error text for classification", () => {
    expect(providerErrorText(event)).toBe(
      "Too many requests Please retry in 4.154791243s",
    );
  });

  it("rejects previously tried handles and accepts a fresh rung", () => {
    expect(canRetryProviderErrorWith(event, "lc-zai-coding/glm-5.3")).toBe(
      false,
    );
    expect(canRetryProviderErrorWith(event, "lc-qwen-code/qwen3.8-max")).toBe(
      true,
    );
  });

  it("accepts the initial provider_error aliases", () => {
    const legacy = {
      status: 429,
      detail: "usage limit reached",
      providerType: "google_ai",
      providerName: "google",
      modelHandle: "google_ai/gemini-3.8-flash",
    } as ModProviderErrorEvent;

    expect(providerErrorText(legacy)).toBe("usage limit reached");
    expect(canRetryProviderErrorWith(legacy, "lc-zai-coding/glm-5.3")).toBe(
      true,
    );
  });
});
