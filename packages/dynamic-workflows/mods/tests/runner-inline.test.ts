import { describe, expect, test } from "vitest";
import { parseFlowAgentMarker } from "../lib/runner-inline.ts";

describe("parseFlowAgentMarker", () => {
  test("parses a workflow agent marker", () => {
    expect(parseFlowAgentMarker("work\n[FLOW_AGENT run_id=1784385035947-abcdef01 phase_id=scan agent_id=race]\nmore")).toEqual({
      runId: "1784385035947-abcdef01",
      phaseId: "scan",
      agentId: "race",
    });
  });

  test("rejects traversal-shaped captures", () => {
    expect(parseFlowAgentMarker("[FLOW_AGENT run_id=../etc/passwd phase_id=scan agent_id=race]")).toBeNull();
    expect(parseFlowAgentMarker("[FLOW_AGENT run_id=1784385035947-abcdef01 phase_id=../../etc agent_id=race]")).toBeNull();
    expect(parseFlowAgentMarker("[FLOW_AGENT run_id=1784385035947-abcdef01 phase_id=scan agent_id=../escape]")).toBeNull();
  });

  test("rejects malformed runId", () => {
    expect(parseFlowAgentMarker("[FLOW_AGENT run_id=run-1 phase_id=scan agent_id=race]")).toBeNull();
  });

  test("returns null for unrelated prompts", () => {
    expect(parseFlowAgentMarker("ordinary agent prompt")).toBeNull();
    expect(parseFlowAgentMarker(undefined)).toBeNull();
  });
});

// Mirrors the tool_end handler predicate in mods/index.ts: only proceed when
// the event is for the Agent tool with a successful status. Regression test
// for H3 (fifth bug-sweep 1784445631272-bdac05f1): the original
// `event.status === "error"` check was a false-negative for missing status.
describe("tool_end status predicate (H3 regression)", () => {
  function shouldRecord(event: { toolName?: string; status?: unknown }): boolean {
    return event.toolName === "Agent" && event.status === "success";
  }

  test("accepts a successful Agent tool_end", () => {
    expect(shouldRecord({ toolName: "Agent", status: "success" })).toBe(true);
  });

  test("rejects an explicit error", () => {
    expect(shouldRecord({ toolName: "Agent", status: "error" })).toBe(false);
  });

  test("rejects an undefined status (the H3 fix)", () => {
    expect(shouldRecord({ toolName: "Agent" })).toBe(false);
    expect(shouldRecord({ toolName: "Agent", status: undefined })).toBe(false);
  });

  test("rejects non-Agent tools regardless of status", () => {
    expect(shouldRecord({ toolName: "Bash", status: "success" })).toBe(false);
    expect(shouldRecord({ toolName: undefined, status: "success" })).toBe(false);
  });
});
