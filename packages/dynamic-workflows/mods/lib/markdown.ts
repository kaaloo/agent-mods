import { parse, stringify } from "yaml";
import type { WorkflowDefinition } from "./schema.ts";
import { validateWorkflow } from "./schema.ts";

export interface ParsedWorkflowMarkdown {
  workflow: WorkflowDefinition;
  body: string;
}

export function parseWorkflowMarkdown(text: string): { workflow?: WorkflowDefinition; errors: string[]; body: string } {
  const trimmed = text.trim();
  const match = trimmed.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { errors: ["Missing YAML frontmatter. Expected file to start with ---"], body: trimmed };
  }
  const [, yamlText, body] = match;
  let data: unknown;
  try {
    data = parse(yamlText);
  } catch (err) {
    return { errors: [`Invalid YAML frontmatter: ${err}`], body: body.trim() };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { errors: ["YAML frontmatter must be an object."], body: body.trim() };
  }
  const validated = validateWorkflow(data as Record<string, unknown>);
  return {
    workflow: validated.workflow,
    errors: validated.errors.map((e) => `${e.path}: ${e.message}`),
    body: body.trim(),
  };
}

export function serializeWorkflowMarkdown(workflow: WorkflowDefinition, body = ""): string {
  const clone: Record<string, unknown> = { ...workflow };
  // Keep frontmatter concise; full description can live in the body if needed.
  const yaml = stringify(clone, { lineWidth: 0, nullStr: "" }).trim();
  const textBody = body.trim();
  if (!textBody) {
    return `---\n${yaml}\n---\n`;
  }
  return `---\n${yaml}\n---\n\n${textBody}\n`;
}

export function workflowWithBody(workflow: WorkflowDefinition, body: string): WorkflowDefinition {
  if (!body.trim()) return workflow;
  return { ...workflow, description: `${workflow.description}\n\n${body.trim()}` };
}

export function loadWorkflowFromMarkdown(text: string): { workflow?: WorkflowDefinition; errors: string[] } {
  const { workflow, errors } = parseWorkflowMarkdown(text);
  return { workflow, errors };
}
