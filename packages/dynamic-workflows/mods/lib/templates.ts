import { readdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { loadWorkflowFromMarkdown } from "./markdown.ts";

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
      if (!entry.isFile() || extname(entry.name) !== ".md") continue;
      const filename = entry.name;
      try {
        const text = readFileSync(`${templateDir}/${filename}`, "utf8");
        const { workflow, errors } = loadWorkflowFromMarkdown(text);
        if (workflow && errors.length === 0) {
          templates.push({
            name: filename.replace(/\.md$/, ""),
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
  try {
    const filename = `${name}.md`;
    const text = readFileSync(`${templateDir}/${filename}`, "utf8");
    const { workflow, errors } = loadWorkflowFromMarkdown(text);
    if (errors.length > 0) return undefined;
    return workflow;
  } catch {
    return undefined;
  }
}
