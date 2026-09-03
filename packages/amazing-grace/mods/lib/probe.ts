// Provider health probe: a forked hidden conversation pinging one rung with
// `overrideModel`. Verified live 2026-08-22: override_model per-request works
// through the messages API and provider failures surface as error responses
// with classifiable text. The probe is both the classifier for failed turns
// (cloud backend has no llm_end events) and the cooldown recovery poll.

import { classifyFailure } from "./classify.ts";
import type { FailureKind } from "./classify.ts";
import type { ModConversationHandle } from "../types.ts";

export type ProbeResult = FailureKind | "ok" | "unavailable";

export interface ProbeOutcome {
  result: ProbeResult;
  detail?: string;
}

function chunkErrorText(chunk: unknown): string | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const record = chunk as Record<string, unknown>;
  const parts: string[] = [];
  for (const source of [record.error, record]) {
    if (typeof source === "string") {
      parts.push(source);
    } else if (typeof source === "object" && source !== null) {
      const src = source as Record<string, unknown>;
      for (const key of ["message", "detail", "error"]) {
        const value = src[key];
        if (typeof value === "string") parts.push(value);
        else if (typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).message === "string") {
          parts.push((value as Record<string, unknown>).message as string);
        }
      }
    }
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function probeRung(conversation: ModConversationHandle, handle: string): Promise<ProbeOutcome> {
  try {
    const forked = await conversation.fork({ hidden: true });
    const stream = await forked.sendMessageStream(
      [{ type: "message", role: "user", content: "Reply with exactly: pong" }],
      { overrideModel: handle, streamTokens: false, background: true },
      { maxRetries: 0 },
    );
    let sawCompletion = false;
    let sawText = false;
    for await (const chunk of stream) {
      const record = chunk as Record<string, unknown>;
      const type = record.message_type ?? record.type;
      if (type === "error_message" || type === "error") {
        const text = chunkErrorText(chunk);
        return { result: classifyFailure(text), ...(text ? { detail: text } : {}) };
      }
      if (type === "assistant_message" || type === "message") {
        const content = record.content ?? record.message;
        if ((typeof content === "string" && content.length > 0) || (Array.isArray(content) && content.length > 0)) {
          sawText = true;
        }
      }
      if (type === "done" || type === "stop_reason" || type === "usage") sawCompletion = true;
    }
    if (sawText || sawCompletion) return { result: "ok" };
    return { result: "unavailable", detail: "stream ended without a completion event" };
  } catch (error) {
    return { result: "unavailable", detail: errorText(error) };
  }
}
