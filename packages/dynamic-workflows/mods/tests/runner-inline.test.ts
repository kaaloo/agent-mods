import { describe, expect, test } from "vitest";
import { parseFlowAgentMarker } from "../lib/runner-inline.ts";

describe("parseFlowAgentMarker", () => {
  test("parses a workflow agent marker", () => {
    expect(parseFlowAgentMarker("work\n[FLOW_AGENT run_id=run-1 phase_id=scan agent_id=race]\nmore")).toEqual({
      runId: "run-1",
      phaseId: "scan",
      agentId: "race",
    });
  });

  test("returns null for unrelated prompts", () => {
    expect(parseFlowAgentMarker("ordinary agent prompt")).toBeNull();
    expect(parseFlowAgentMarker(undefined)).toBeNull();
  });
});
