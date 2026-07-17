import { readdirSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { validateWorkflow } from "./schema.ts";

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
      if (!entry.isFile() || extname(entry.name) !== ".json") continue;
      const filename = entry.name;
      const text = readFileSync(`${templateDir}/${filename}`, "utf8");
      try {
        const parsed = JSON.parse(text);
        const { workflow, errors } = validateWorkflow(parsed);
        if (workflow && errors.length === 0) {
          templates.push({
            name: filename.replace(/\.json$/, ""),
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

export function loadTemplate(templateDir: string, name: string) {
  const filename = `${name}.json`;
  const text = readFileSync(`${templateDir}/${filename}`, "utf8");
  const parsed = JSON.parse(text);
  const { workflow } = validateWorkflow(parsed);
  return workflow;
}
