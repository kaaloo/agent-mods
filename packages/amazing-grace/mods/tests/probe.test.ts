import { describe, expect, it, vi } from "vitest";
import { probeRung } from "../lib/probe.ts";
import type { ModConversationHandle, ModStreamChunk } from "../types.ts";

function stream(chunks: ModStreamChunk[]): AsyncIterable<ModStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function conversation(chunks: ModStreamChunk[]): ModConversationHandle {
  const forked = {
    id: "forked",
    fork: vi.fn(),
    sendMessageStream: vi.fn().mockResolvedValue(stream(chunks)),
  } satisfies ModConversationHandle;
  return {
    id: "source",
    fork: vi.fn().mockResolvedValue(forked),
    sendMessageStream: vi.fn(),
  };
}

describe("probeRung", () => {
  it("uses Letta message input and recognizes current stream chunks", async () => {
    const source = conversation([
      { message_type: "assistant_message", content: [{ type: "text", text: "pong" }] },
      { message_type: "stop_reason", stop_reason: "end_turn" },
    ]);

    await expect(probeRung(source, "letta/auto")).resolves.toEqual({ result: "ok" });
    const forked = await source.fork();
    expect(forked.sendMessageStream).toHaveBeenCalledWith(
      [{ type: "message", role: "user", content: "Reply with exactly: pong" }],
      { overrideModel: "letta/auto", streamTokens: false, background: true },
      { maxRetries: 0 },
    );
  });

  it("classifies error_message chunks and preserves detail", async () => {
    const source = conversation([
      { message_type: "error_message", message: "429 usage limit reached" },
    ]);

    await expect(probeRung(source, "lc-codex/gpt-5.6-sol")).resolves.toEqual({
      result: "quota",
      detail: "429 usage limit reached",
    });
  });

  it("preserves thrown runtime errors", async () => {
    const source = conversation([]);
    source.fork = vi.fn().mockRejectedValue(new Error("fork unavailable"));

    await expect(probeRung(source, "letta/auto")).resolves.toEqual({
      result: "unavailable",
      detail: "fork unavailable",
    });
  });
});
