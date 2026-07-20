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
import { stepInlineRun } from "../lib/runner-inline.ts";

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
  test("creates a run with checkpoint and parent model", async () => {
    const run = await createRun(
      sampleWorkflow,
      {},
      "conversation-1",
      "/tmp/project",
      "openai/gpt-5.6-sol",
      "agent-owner0001",
    );
    expect(run.runId).toBeTruthy();
    expect(run.status).toBe("running");
    expect(run.currentPhaseId).toBe("scan");
    expect(run.model).toBe("openai/gpt-5.6-sol");
    expect(run.agentId).toBe("agent-owner0001");

    const reloaded = loadRun(run.runId);
    expect(reloaded?.runId).toBe(run.runId);
    expect(reloaded?.model).toBe("openai/gpt-5.6-sol");
    expect(reloaded?.agentId).toBe("agent-owner0001");
    expect(getRunDir(run.runId)).toContain(tempDir);
  });

  test("dispatches every agent with the parent conversation model", async () => {
    const run = await createRun(sampleWorkflow, {}, "conversation-1", "/tmp/project", "openai/gpt-5.6-sol");
    const step = await stepInlineRun(run.runId);
    expect(step?.type).toBe("dispatch");
    if (!step || step.type !== "dispatch") return;
    expect(step.agents).toHaveLength(1);
    expect(step.agents?.[0]?.model).toBe("openai/gpt-5.6-sol");
    expect(step.agents?.[0]?.runInBackground).toBe(false);
    expect(step.agents?.[0]?.prompt).toContain("Return your complete findings in the Agent tool result");
    expect(step.agents?.[0]?.prompt).not.toContain("When you are done, write");
    expect(step.instructions).toContain("together in one response so they run in parallel");
    expect(step.instructions).toContain("Set run_in_background to false");
    expect(step.instructions).toContain("never call TaskOutput");
    expect(step.instructions).toContain('First use model "openai/gpt-5.6-sol"');
    expect(step.instructions).toContain("retry once with the model argument omitted so Letta uses Auto");
  });

  test("uses Auto when the parent conversation model is unavailable", async () => {
    const run = await createRun(sampleWorkflow, {}, "conversation-1", "/tmp/project");
    const step = await stepInlineRun(run.runId);
    expect(step?.type).toBe("dispatch");
    if (!step || step.type !== "dispatch") return;
    expect(step.agents?.[0]?.model).toBeUndefined();
    expect(step.instructions).toContain("Use Auto by omitting the Agent model argument");
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
