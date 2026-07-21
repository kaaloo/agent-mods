import { describe, expect, test, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWorkflowMarkdown } from "../lib/markdown.ts";
import { isFanOutPhase, isBarrierPhase, nextPhase, isPhaseComplete, WORKFLOW_VERSION, type WorkflowDefinition } from "../lib/schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let workflow: WorkflowDefinition;

beforeAll(() => {
  const filePath = path.resolve(__dirname, "../../assets/built-in/code-audit.md");
  const text = readFileSync(filePath, "utf8");
  const parsed = parseWorkflowMarkdown(text);
  if (!parsed.workflow || parsed.errors.length > 0) {
    throw new Error(`Failed to parse code-audit.md: ${parsed.errors.join("; ")}`);
  }
  workflow = parsed.workflow;
});

describe("code-audit workflow structure", () => {
  test("has valid metadata", () => {
    expect(workflow.name).toBe("code-audit");
    expect(workflow.version).toBe(WORKFLOW_VERSION);
    expect(workflow.description).toBeTruthy();
  });

  test("has exactly three phases", () => {
    expect(workflow.phases).toHaveLength(3);
  });

  test("phase 1 is scan (fan-out) with four agents", () => {
    const phase = workflow.phases[0];
    expect(phase.id).toBe("scan");
    expect(isFanOutPhase(phase)).toBe(true);
    if (isFanOutPhase(phase)) {
      expect(phase.agents).toHaveLength(4);
      const agentIds = phase.agents.map((a) => a.id).sort();
      expect(agentIds).toEqual(["concurrency", "nullability", "reliability", "security"]);
      for (const agent of phase.agents) {
        expect(agent.prompt).toBeTruthy();
        expect(agent.prompt.length).toBeGreaterThan(200);
      }
    }
  });

  test("phase 2 is verify (barrier) depending on scan", () => {
    const phase = workflow.phases[1];
    expect(phase.id).toBe("verify");
    expect(isBarrierPhase(phase)).toBe(true);
    if (isBarrierPhase(phase)) {
      expect(phase.depends_on).toEqual(["scan"]);
      expect(phase.prompt).toBeTruthy();
    }
  });

  test("phase 3 is report (barrier) depending on verify", () => {
    const phase = workflow.phases[2];
    expect(phase.id).toBe("report");
    expect(isBarrierPhase(phase)).toBe(true);
    if (isBarrierPhase(phase)) {
      expect(phase.depends_on).toEqual(["verify"]);
      expect(phase.prompt).toBeTruthy();
    }
  });

  test("budgets with max_concurrent", () => {
    expect(workflow.budgets?.max_concurrent).toBe(4);
  });
});

describe("code-audit phase chaining", () => {
  test("nextPhase returns verify after scan completes", () => {
    const next = nextPhase(workflow, new Set(["scan"]));
    expect(next?.id).toBe("verify");
  });

  test("nextPhase returns report after scan and verify complete", () => {
    const next = nextPhase(workflow, new Set(["scan", "verify"]));
    expect(next?.id).toBe("report");
  });

  test("nextPhase returns undefined after all phases complete", () => {
    const next = nextPhase(workflow, new Set(["scan", "verify", "report"]));
    expect(next).toBeUndefined();
  });

  test("nextPhase returns scan when scan is not yet complete", () => {
    // nextPhase skips completed phases. scan is not completed and is not a
    // barrier, so it is the next dispatchable phase regardless of what comes
    // after it. Keep this test to document the behavior.
    const next = nextPhase(workflow, new Set(["verify"]));
    expect(next?.id).toBe("scan");
  });
});

describe("code-audit isPhaseComplete", () => {
  test("scan is complete when all four agents report", () => {
    const scanPhase = workflow.phases[0];
    expect(isFanOutPhase(scanPhase)).toBe(true);
    if (isFanOutPhase(scanPhase)) {
      const allAgentIds = new Set(scanPhase.agents.map((a) => a.id));
      expect(isPhaseComplete(workflow, "scan", allAgentIds)).toBe(true);

      const partial = new Set(["concurrency", "nullability"]);
      expect(isPhaseComplete(workflow, "scan", partial)).toBe(false);
    }
  });

  test("verify is complete when scan agents are done", () => {
    const scanPhase = workflow.phases[0] as { agents: Array<{ id: string }> };
    const allAgentIds = new Set(scanPhase.agents.map((a) => a.id));

    // A barrier that depends on a fan-out phase requires every agent result,
    // not the fan-out phase ID in completedPhaseIds.
    expect(isPhaseComplete(workflow, "verify", allAgentIds)).toBe(true);
  });

  test("report depends on verify (barrier), needs verify in completedPhaseIds", () => {
    const scanPhase = workflow.phases[0] as { agents: Array<{ id: string }> };
    const allAgentIds = new Set(scanPhase.agents.map((a) => a.id));

    // report depends on verify (barrier), which requires completedPhaseIds.has("verify")
    expect(isPhaseComplete(workflow, "report", allAgentIds)).toBe(false);
    expect(isPhaseComplete(workflow, "report", allAgentIds, new Set(["scan"]))).toBe(false);
    expect(isPhaseComplete(workflow, "report", allAgentIds, new Set(["scan", "verify"]))).toBe(true);
  });
});
