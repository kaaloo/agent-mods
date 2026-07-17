import type { WorkflowDefinition } from "./schema.ts";
import { validateWorkflow, formatValidationErrors } from "./schema.ts";

export interface AuthorInput {
  task: string;
  pattern?: "fan-out-barrier" | "research-verify" | "audit" | "custom";
  hints?: string;
}

export function buildAuthorPrompt(input: AuthorInput): string {
  const patternDescription = describePattern(input.pattern ?? "custom");
  return `You are a workflow architect. Design a JSON workflow definition for the following task.

Task: ${input.task}
${input.hints ? `Additional hints: ${input.hints}\n` : ""}
Pattern guidance: ${patternDescription}

The workflow must conform to this JSON schema:

{
  "name": "kebab-case-workflow-name",
  "version": "1",
  "description": "One-line description.",
  "phases": [
    {
      "id": "scan",
      "type": "fan-out",
      "model": "optional-model-handle",
      "concurrency": 4,
      "agents": [
        { "id": "agent-1", "prompt": "Detailed prompt for this subagent." }
      ]
    },
    {
      "id": "synthesize",
      "type": "barrier",
      "depends_on": ["scan"],
      "model": "optional-model-handle",
      "prompt": "Prompt that references prior phase outputs."
    }
  ],
  "budgets": {
    "max_tokens": 500000,
    "max_concurrent": 4,
    "max_duration_ms": 3600000
  }
}

Rules:
- Use only "fan-out" and "barrier" phase types.
- Every fan-out phase must have at least one agent.
- Every barrier phase must have a non-empty "depends_on" array referencing earlier phase ids.
- Agent prompts should be self-contained and concrete.
- Model handles are optional; omit to use the default model.
- Keep the workflow small and debuggable for a first run.

After you generate the workflow, call workflow_save with the JSON object. Do not wrap the JSON in markdown code fences.`;
}

export function authorWorkflow(input: AuthorInput): { workflow?: WorkflowDefinition; prompt: string; error?: string } {
  const prompt = buildAuthorPrompt(input);
  return { prompt };
}

export function parseWorkflowJson(text: string): { workflow?: WorkflowDefinition; error?: string } {
  let trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/```(?:json)?\n?/g, "").replace(/\n?```$/, "").trim();
  }
  try {
    const parsed = JSON.parse(trimmed);
    const { workflow, errors } = validateWorkflow(parsed);
    if (errors.length > 0) {
      return { error: formatValidationErrors(errors) };
    }
    return { workflow };
  } catch (error) {
    return { error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function describePattern(pattern: string): string {
  switch (pattern) {
    case "fan-out-barrier":
      return "Use a fan-out phase to run parallel subagents, then a barrier phase to synthesize their outputs into a single result.";
    case "research-verify":
      return "Use a fan-out phase to gather evidence from multiple angles, then a barrier phase to verify and cross-check.";
    case "audit":
      return "Use a fan-out phase to inspect different parts of the system, then a barrier phase to aggregate findings.";
    case "custom":
    default:
      return "Choose the simplest phase structure that fits the task. Prefer fan-out + barrier unless there is a clear reason for something else.";
  }
}
