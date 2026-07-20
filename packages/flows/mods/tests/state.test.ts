import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readState,
  writeState,
  saveLibraryEntry,
  loadLibraryEntry,
  listLibrary,
  createRun,
  loadRun,
  saveAgentResult,
  loadAgentResult,
  getLettaHome,
  getRunDir,
  getRegistryPath,
  getLibraryDir,
  readRunAgentOutput,
} from "../lib/state.ts";
import { WORKFLOW_VERSION, type WorkflowDefinition } from "../lib/schema.ts";

let originalLettaHome: string | undefined;
let tempDir: string;

const sampleWorkflow = {
  name: "test-workflow",
  version: WORKFLOW_VERSION,
  description: "Test.",
  phases: [
    {
      id: "scan",
      type: "fan-out" as const,
      agents: [{ id: "a1", prompt: "p1" }],
    },
    {
      id: "synthesize",
      type: "barrier" as const,
      depends_on: ["scan"],
      prompt: "merge",
    },
  ],
} satisfies WorkflowDefinition;

beforeEach(() => {
  originalLettaHome = process.env.LETTA_HOME;
  tempDir = mkdtempSync(path.join(tmpdir(), "dw-state-"));
  process.env.LETTA_HOME = tempDir;
});

afterEach(() => {
  if (originalLettaHome === undefined) {
    delete process.env.LETTA_HOME;
  } else {
    process.env.LETTA_HOME = originalLettaHome;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("getLettaHome", () => {
  test("respects LETTA_HOME", () => {
    expect(getLettaHome()).toBe(tempDir);
  });
});

describe("readState and writeState", () => {
  test("returns empty state when missing", () => {
    const state = readState();
    expect(state.version).toBe(1);
    expect(Object.keys(state.runs)).toHaveLength(0);
  });

  test("round-trips state", () => {
    const state = readState();
    state.runs = { "run-1": { status: "running" as const, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), currentPhaseId: "scan" } };
    writeState(state);
    const reloaded = readState();
    expect(reloaded.runs["run-1"]).toBeTruthy();
  });

  test("M4: drops corrupted status values and defaults to running", () => {
    const state = readState();
    state.runs = {
      "run-clean": { status: "completed" as const, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), currentPhaseId: null },
      "run-bogus": { status: "bogus" as any, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), currentPhaseId: null },
    };
    writeState(state);
    const reloaded = readState();
    expect(reloaded.runs["run-clean"]?.status).toBe("completed");
    expect(reloaded.runs["run-bogus"]?.status).toBe("running");
  });
});

describe("library", () => {
  test("saves and loads entry as markdown", () => {
    const entry = {
      name: "bug-sweep",
      description: "Sweep for bugs.",
      workflow: sampleWorkflow,
      savedAt: new Date().toISOString(),
    };
    saveLibraryEntry(entry);
    const filePath = path.join(getLibraryDir(), "bug-sweep.md");
    expect(existsSync(filePath)).toBe(true);
    const text = readFileSync(filePath, "utf8");
    expect(text.startsWith("---")).toBe(true);
    const loaded = loadLibraryEntry("bug-sweep");
    expect(loaded?.name).toBe("bug-sweep");
    expect(listLibrary()).toHaveLength(1);
  });
});

describe("runs", () => {
  test("creates a run with checkpoint", async () => {
    const run = await createRun(sampleWorkflow);
    expect(run.runId).toBeTruthy();
    expect(run.status).toBe("running");
    expect(run.currentPhaseId).toBe("scan");

    const reloaded = loadRun(run.runId);
    expect(reloaded?.runId).toBe(run.runId);
    expect(getRunDir(run.runId)).toContain(tempDir);
  });

  test("saves and loads agent result", async () => {
    const run = await createRun(sampleWorkflow);
    saveAgentResult(run.runId, "scan", {
      phaseId: "scan",
      agentId: "a1",
      prompt: "p1",
      status: "completed",
      output: "found nothing",
    });
    const loaded = loadAgentResult(run.runId, "scan", "a1");
    expect(loaded?.output).toBe("found nothing");
    expect(readRunAgentOutput(run.runId, "scan", "a1")).toBe("found nothing");
  });

  test("M5: rejects a run.md with a missing currentPhaseId", async () => {
    const run = await createRun(sampleWorkflow);
    const runPath = path.join(getRunDir(run.runId), "run.md");
    // Rewrite run.md without the currentPhaseId field to simulate corruption.
    const fs = await import("node:fs");
    const original = fs.readFileSync(runPath, "utf8");
    const corrupted = original.replace(/currentPhaseId:.*\n/, "");
    fs.writeFileSync(runPath, corrupted, "utf8");
    expect(loadRun(run.runId)).toBeNull();
  });

  test("M6: drops invalid outputs values from a corrupted run.md", async () => {
    const run = await createRun(sampleWorkflow);
    const fs = await import("node:fs");
    const runPath = path.join(getRunDir(run.runId), "run.md");
    const original = fs.readFileSync(runPath, "utf8");
    const corrupted = original.replace(
      /outputs: {}\n/,
      "outputs:\n  good: \"ok\"\n  bad_number: 123\n  bad_null: null\n  good_record:\n    a: \"x\"\n  bad_record:\n    a: 42\n"
    );
    fs.writeFileSync(runPath, corrupted, "utf8");
    const reloaded = loadRun(run.runId);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.outputs["good"]).toBe("ok");
    expect(reloaded?.outputs["good_record"]).toEqual({ a: "x" });
    expect(reloaded?.outputs["bad_number"]).toBeUndefined();
    expect(reloaded?.outputs["bad_null"]).toBeUndefined();
    expect(reloaded?.outputs["bad_record"]).toBeUndefined();
  });
});

afterEach(() => {
  // Ensure registry path is inside temp dir for isolation.
  expect(getRegistryPath()).toContain(tempDir);
});
