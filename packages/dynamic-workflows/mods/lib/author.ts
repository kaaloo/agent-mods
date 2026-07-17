import { formatValidationErrors } from "./schema.ts";
import type { WorkflowDefinition } from "./schema.ts";
import { parseWorkflowMarkdown, serializeWorkflowMarkdown } from "./markdown.ts";

export interface AuthorInput {
  task: string;
  pattern?: "fan-out-barrier" | "research-verify" | "audit" | "custom";
  hints?: string;
}

export function buildAuthorPrompt(input: AuthorInput): string {
  const patternDescription = describePattern(input.pattern ?? "custom");
  const example = serializeWorkflowMarkdown({
    name: "kebab-case-workflow-name",
    version: "1",
    description: "One-line description.",
    phases: [
      {
        id: "scan",
        type: "fan-out",
        concurrency: 4,
        agents: [{ id: "agent-1", prompt: "Detailed prompt for this subagent." }],
      },
      {
        id: "synthesize",
        type: "barrier",
        depends_on: ["scan"],
        prompt: "Prompt that references prior phase outputs.",
      },
    ],
    budgets: {
      max_tokens: 500000,
      max_concurrent: 4,
      max_duration_ms: 3600000,
    },
  }, "Optional longer descriptive content in Markdown.");

  return `You are a workflow architect. Design a Markdown file with YAML frontmatter for the following task.

Task: ${input.task}
${input.hints ? `Additional hints: ${input.hints}\n` : ""}Pattern guidance: ${patternDescription}

The workflow must use this format:

${example}

Rules:
- The file must start with YAML frontmatter between triple dashes (---).
- The frontmatter must include: name, version, description, phases, and optionally budgets.
- Use only "fan-out" and "barrier" phase types.
- Every fan-out phase must have at least one agent.
- Every barrier phase must have a non-empty "depends_on" array referencing earlier phase ids.
- Agent prompts should be self-contained and concrete.
- Model handles are optional; omit to use the default model.
- Keep the workflow small and debuggable for a first run.
- Use the Markdown body below the frontmatter for descriptive content about the workflow.

After you generate the workflow, call workflow_save with the Markdown content as the "workflow" argument.`;
}

export function authorWorkflow(input: AuthorInput): { workflow?: WorkflowDefinition; prompt: string; error?: string } {
  const prompt = buildAuthorPrompt(input);
  return { prompt };
}

export function parseWorkflowMarkdownText(text: string): { workflow?: WorkflowDefinition; error?: string } {
  const { workflow, errors } = parseWorkflowMarkdown(text);
  if (errors.length > 0) {
    return { error: formatValidationErrors(errors.map((e) => ({ path: e, message: e }))) };
  }
  return { workflow };
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

export function stripMarkdownFences(text: string): string {
  let trimmed = text.trim();
  if (trimmed.startsWith("```")) {
    trimmed = trimmed.replace(/```(?:markdown|md)?\n?/g, "").replace(/\n?```$/, "").trim();
  }
  return trimmed;
}
