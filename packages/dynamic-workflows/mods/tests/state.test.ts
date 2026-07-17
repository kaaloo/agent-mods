import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
  setUltracode,
  getUltracode,
  getLettaHome,
  getRunDir,
  getStatePath,
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
    expect(Object.keys(state.library)).toHaveLength(0);
  });

  test("round-trips state", () => {
    const state = readState();
    state.ultracode = true;
    writeState(state);
    const reloaded = readState();
    expect(reloaded.ultracode).toBe(true);
  });
});

describe("library", () => {
  test("saves and loads entry", () => {
    const entry = {
      name: "bug-sweep",
      description: "Sweep for bugs.",
      workflow: sampleWorkflow,
      savedAt: new Date().toISOString(),
    };
    saveLibraryEntry(entry);
    const loaded = loadLibraryEntry("bug-sweep");
    expect(loaded?.name).toBe("bug-sweep");
    expect(listLibrary()).toHaveLength(1);
  });
});

describe("runs", () => {
  test("creates a run with checkpoint", () => {
    const run = createRun(sampleWorkflow);
    expect(run.runId).toBeTruthy();
    expect(run.status).toBe("running");
    expect(run.currentPhaseId).toBe("scan");

    const reloaded = loadRun(run.runId);
    expect(reloaded?.runId).toBe(run.runId);
    expect(getRunDir(run.runId)).toContain(tempDir);
  });

  test("saves and loads agent result", () => {
    const run = createRun(sampleWorkflow);
    saveAgentResult(run.runId, "scan", {
      phaseId: "scan",
      agentId: "a1",
      prompt: "p1",
      status: "completed",
      output: "found nothing",
    });
    const loaded = loadAgentResult(run.runId, "scan", "a1");
    expect(loaded?.output).toBe("found nothing");
  });
});

describe("ultracode", () => {
  test("toggles", () => {
    expect(getUltracode()).toBe(false);
    setUltracode(true);
    expect(getUltracode()).toBe(true);
  });
});

afterEach(() => {
  // Ensure state path is inside temp dir for isolation.
  expect(getStatePath()).toContain(tempDir);
});
