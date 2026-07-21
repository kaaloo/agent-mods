import { describe, expect, test } from "vitest";
import {
  validateWorkflow,
  isFanOutPhase,
  isBarrierPhase,
  nextPhase,
  isPhaseComplete,
  WORKFLOW_VERSION,
  type WorkflowDefinition,
  type Phase,
} from "../lib/schema.ts";

const validWorkflow = {
  name: "bug-sweep",
  version: WORKFLOW_VERSION,
  description: "Sweep the codebase for bugs.",
  phases: [
    {
      id: "scan",
      type: "fan-out" as const,
      agents: [
        { id: "race", prompt: "Find race conditions." },
        { id: "null", prompt: "Find null derefs." },
      ],
    },
    {
      id: "synthesize",
      type: "barrier" as const,
      depends_on: ["scan"],
      prompt: "Merge findings.",
    },
  ],
} satisfies WorkflowDefinition;

describe("validateWorkflow", () => {
  test("accepts a valid workflow", () => {
    const { workflow, errors } = validateWorkflow(validWorkflow);
    expect(errors).toHaveLength(0);
    expect(workflow?.name).toBe("bug-sweep");
  });

  test("rejects missing name", () => {
    const { errors } = validateWorkflow({ ...validWorkflow, name: "" });
    expect(errors.some((e) => e.path === "name")).toBe(true);
  });

  test("rejects bad version", () => {
    const { errors } = validateWorkflow({ ...validWorkflow, version: "2" });
    expect(errors.some((e) => e.path === "version")).toBe(true);
  });

  test("rejects empty phases", () => {
    const { errors } = validateWorkflow({ ...validWorkflow, phases: [] });
    expect(errors.some((e) => e.path === "phases")).toBe(true);
  });

  test("rejects duplicate phase ids", () => {
    const bad = {
      ...validWorkflow,
      phases: [
        { ...validWorkflow.phases[0], id: "scan" },
        { ...validWorkflow.phases[1], id: "scan" },
      ],
    };
    const { errors } = validateWorkflow(bad);
    expect(errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
  });

  test("rejects barrier with unknown depends_on", () => {
    const bad = {
      ...validWorkflow,
      phases: [
        validWorkflow.phases[0],
        { ...validWorkflow.phases[1], depends_on: ["missing"] },
      ],
    };
    const { errors } = validateWorkflow(bad);
    expect(errors.some((e) => e.message.includes("Unknown phase"))).toBe(true);
  });

  test("rejects bad phase type", () => {
    const bad = { ...validWorkflow, phases: [{ id: "x", type: "unknown" }] };
    const { errors } = validateWorkflow(bad);
    expect(errors.some((e) => e.path.includes("type"))).toBe(true);
  });

  test("rejects per-phase model overrides", () => {
    const bad = {
      ...validWorkflow,
      phases: [{ ...validWorkflow.phases[0], model: "kimi-for-coding" }, validWorkflow.phases[1]],
    };
    const { errors } = validateWorkflow(bad);
    expect(errors).toContainEqual({
      path: "phases[0].model",
      message: "Per-phase model overrides are not supported; the flow runtime tries the current conversation model and falls back to Auto.",
    });
  });

  test("rejects invalid max_concurrent", () => {
    const bad = { ...validWorkflow, budgets: { max_concurrent: -1 } };
    const { errors } = validateWorkflow(bad);
    expect(errors.some((e) => e.path === "budgets.max_concurrent")).toBe(true);
  });

  test.each(["max_tokens", "max_duration_ms"])("rejects unsupported v1 budget %s", (field) => {
    const bad = { ...validWorkflow, budgets: { [field]: 1000 } };
    const { errors } = validateWorkflow(bad);
    expect(errors).toContainEqual({
      path: `budgets.${field}`,
      message: `${field} is not supported in workflow version 1.`,
    });
  });

  test("rejects barrier depending on a later phase", () => {
    const bad = {
      ...validWorkflow,
      phases: [
        validWorkflow.phases[1], // synthesize first
        validWorkflow.phases[0], // scan second
      ],
    };
    const { errors } = validateWorkflow(bad);
    expect(errors.some((e) => e.message.includes("later or current phase"))).toBe(true);
  });

  test("rejects barrier depending on itself", () => {
    const bad = {
      ...validWorkflow,
      phases: [
        validWorkflow.phases[0],
        { ...validWorkflow.phases[1], depends_on: ["synthesize"] },
      ],
    };
    const { errors } = validateWorkflow(bad);
    expect(errors.some((e) => e.message.includes("later or current phase"))).toBe(true);
  });
});

describe("phase helpers", () => {
  test("isFanOutPhase and isBarrierPhase", () => {
    expect(isFanOutPhase(validWorkflow.phases[0] as Phase)).toBe(true);
    expect(isBarrierPhase(validWorkflow.phases[1] as Phase)).toBe(true);
  });

  test("nextPhase returns barrier after scan completes", () => {
    const next = nextPhase(validWorkflow, new Set(["scan"]));
    expect(next?.id).toBe("synthesize");
  });

  test("nextPhase returns undefined when all phases complete", () => {
    const next = nextPhase(validWorkflow, new Set(["scan", "synthesize"]));
    expect(next).toBeUndefined();
  });

  test("isPhaseComplete requires barrier dependencies to be completed", () => {
    const barrierOnBarrier = {
      name: "b-on-b",
      version: WORKFLOW_VERSION,
      description: "Barrier on barrier.",
      phases: [
        {
          id: "scan",
          type: "fan-out" as const,
          agents: [{ id: "a", prompt: "p" }],
        },
        {
          id: "mid",
          type: "barrier" as const,
          depends_on: ["scan"],
          prompt: "merge",
        },
        {
          id: "final",
          type: "barrier" as const,
          depends_on: ["mid"],
          prompt: "final",
        },
      ],
    } satisfies WorkflowDefinition;
    const final = barrierOnBarrier.phases[2];
    const completedAgents = new Set(["a"]);
    // Without completedPhaseIds the final barrier is not complete even though
    // its fan-out dependency is satisfied.
    expect(isPhaseComplete(barrierOnBarrier, final.id, completedAgents)).toBe(false);
    expect(isPhaseComplete(barrierOnBarrier, final.id, completedAgents, new Set(["scan"]))).toBe(false);
    expect(isPhaseComplete(barrierOnBarrier, final.id, completedAgents, new Set(["scan", "mid"]))).toBe(true);
  });

  test("isPhaseComplete for fan-out requires all agents", () => {
    const fanOut = validWorkflow.phases[0] as Phase;
    expect(isPhaseComplete(validWorkflow, fanOut.id, new Set(["race"]))).toBe(false);
    expect(isPhaseComplete(validWorkflow, fanOut.id, new Set(["race", "null"]))).toBe(true);
  });
});
