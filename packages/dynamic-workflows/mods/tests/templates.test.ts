import { expect, test } from "vitest";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { listTemplates, loadTemplate } from "../lib/templates.ts";
import { WORKFLOW_VERSION } from "../lib/schema.ts";

let tempDir: string;

test("listTemplates reads valid templates", () => {
  tempDir = mkdtempSync(path.join(tmpdir(), "dw-templates-"));
  const good = JSON.stringify({
    name: "good-template",
    version: WORKFLOW_VERSION,
    description: "A good template.",
    phases: [{ id: "p1", type: "fan-out", agents: [{ id: "a1", prompt: "p" }] }],
  });
  const bad = "not json";
  writeFileSync(path.join(tempDir, "good-template.json"), good);
  writeFileSync(path.join(tempDir, "bad.json"), bad);

  const list = listTemplates(tempDir);
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe("good-template");

  const loaded = loadTemplate(tempDir, "good-template");
  expect(loaded?.name).toBe("good-template");

  rmSync(tempDir, { recursive: true, force: true });
});
