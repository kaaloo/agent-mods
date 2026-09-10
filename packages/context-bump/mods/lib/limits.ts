// Raise-only patch building. The mod never lowers an already-higher limit:
// it only patches a field when the current value is an explicit number below
// the target. Null/undefined (inherited) values are left alone because the
// agent-scope raise covers them.

import type { LimitTarget } from "./config.ts";

export interface CurrentLimits {
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

function raised(current: number | null | undefined, target: number): number | null {
  if (typeof current !== "number") return null;
  if (current >= target) return null;
  return target;
}

export function buildRaisePatch(current: CurrentLimits, target: LimitTarget): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  const contextWindow = raised(current.contextWindow, target.contextWindow);
  if (contextWindow !== null) patch.context_window_limit = contextWindow;
  const maxOutputTokens = raised(current.maxOutputTokens, target.maxOutputTokens);
  if (maxOutputTokens !== null) patch.model_settings = { max_output_tokens: maxOutputTokens };
  return Object.keys(patch).length > 0 ? patch : null;
}
