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
