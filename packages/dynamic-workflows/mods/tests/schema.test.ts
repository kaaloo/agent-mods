import { describe, expect, test } from "vitest";
import {
  validateWorkflow,
  isFanOutPhase,
  isBarrierPhase,
  nextPhase,
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

  test("rejects negative budgets", () => {
    const bad = { ...validWorkflow, budgets: { max_tokens: -1 } };
    const { errors } = validateWorkflow(bad);
    expect(errors.some((e) => e.path.includes("max_tokens"))).toBe(true);
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
});
