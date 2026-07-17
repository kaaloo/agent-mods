import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { loadWorkflowFromMarkdown } from "./markdown.ts";
import { isSafeIdentifier, isContainedPath } from "./utils.ts";

export interface TemplateEntry {
  name: string;
  description: string;
  source: "template";
}

export function listTemplates(templateDir: string): TemplateEntry[] {
  try {
    const entries = readdirSync(templateDir, { withFileTypes: true });
    const templates: TemplateEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name) !== ".md") continue;
      const filename = entry.name;
      const name = filename.replace(/\.md$/, "");
      if (!isSafeIdentifier(name)) continue;
      try {
        const filePath = path.join(templateDir, filename);
        if (!isContainedPath(templateDir, filePath)) continue;
        const text = readFileSync(filePath, "utf8");
        const { workflow, errors } = loadWorkflowFromMarkdown(text);
        if (workflow && errors.length === 0) {
          templates.push({
            name,
            description: workflow.description,
            source: "template",
          });
        }
      } catch {
        // Skip malformed template files.
      }
    }
    return templates;
  } catch {
    return [];
  }
}

export function loadTemplate(templateDir: string, name: string): import("./schema.ts").WorkflowDefinition | undefined {
  if (!isSafeIdentifier(name)) return undefined;
  try {
    const filename = `${name}.md`;
    const filePath = path.join(templateDir, filename);
    if (!isContainedPath(templateDir, filePath)) return undefined;
    const text = readFileSync(filePath, "utf8");
    const { workflow, errors } = loadWorkflowFromMarkdown(text);
    if (errors.length > 0) return undefined;
    return workflow;
  } catch {
    return undefined;
  }
}
