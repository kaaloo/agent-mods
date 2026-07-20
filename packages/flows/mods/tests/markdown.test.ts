import { describe, expect, test } from "vitest";
import { parseWorkflowMarkdown, serializeWorkflowMarkdown } from "../lib/markdown.ts";
import { WORKFLOW_VERSION, type WorkflowDefinition } from "../lib/schema.ts";

const sampleWorkflow = {
  name: "test",
  version: WORKFLOW_VERSION,
  description: "Test workflow.",
  phases: [
    { id: "scan", type: "fan-out" as const, agents: [{ id: "a1", prompt: "p1" }] },
    { id: "synth", type: "barrier" as const, depends_on: ["scan"], prompt: "merge" },
  ],
  budgets: { max_concurrent: 2, max_duration_ms: 1000 },
} satisfies WorkflowDefinition;

describe("parseWorkflowMarkdown", () => {
  test("parses valid frontmatter", () => {
    const md = serializeWorkflowMarkdown(sampleWorkflow, "Body text.");
    const parsed = parseWorkflowMarkdown(md);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.workflow?.name).toBe("test");
    expect(parsed.workflow?.phases).toHaveLength(2);
    expect(parsed.body).toBe("Body text.");
  });

  test("returns error for missing frontmatter", () => {
    const parsed = parseWorkflowMarkdown("no frontmatter");
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  test("returns error for invalid workflow data", () => {
    const md = `---\nname: test\n---\n`;
    const parsed = parseWorkflowMarkdown(md);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

describe("serializeWorkflowMarkdown", () => {
  test("round-trips workflow", () => {
    const md = serializeWorkflowMarkdown(sampleWorkflow);
    const parsed = parseWorkflowMarkdown(md);
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.workflow?.name).toBe("test");
  });
});
