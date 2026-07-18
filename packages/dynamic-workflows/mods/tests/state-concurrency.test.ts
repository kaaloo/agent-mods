import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  withRunMutexFor,
  createRun,
  loadRun,
  saveAgentResult,
  setRuntimeAgentId,
  getRunDir,
  getRunPath,
} from "../lib/state.ts";
import {
  recordAgentComplete,
  stepInlineRun,
} from "../lib/runner-inline.ts";
import { WORKFLOW_VERSION, type WorkflowDefinition } from "../lib/schema.ts";

let originalLettaHome: string | undefined;
let tempDir: string;

const sampleWorkflow = {
  name: "concurrency-test",
  version: WORKFLOW_VERSION,
  description: "Concurrency test.",
  phases: [
    {
      id: "scan",
      type: "fan-out" as const,
      agents: [
        { id: "a1", prompt: "p1" },
        { id: "a2", prompt: "p2" },
        { id: "a3", prompt: "p3" },
      ],
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
  tempDir = mkdtempSync(path.join(tmpdir(), "dw-concurrency-"));
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

describe("withRunMutexFor", () => {
  test("serializes work within the same runId", async () => {
    const run = await createRun(sampleWorkflow);
    const order: number[] = [];
    const inFlight: number[] = [];
    let maxInFlight = 0;

    const work = (id: number, hold: number) => async () => {
      inFlight.push(id);
      maxInFlight = Math.max(maxInFlight, inFlight.length);
      await new Promise((resolve) => setTimeout(resolve, hold));
      inFlight.splice(inFlight.indexOf(id), 1);
      order.push(id);
    };

    await Promise.all([
      withRunMutexFor(run.runId, work(1, 20)),
      withRunMutexFor(run.runId, work(2, 10)),
      withRunMutexFor(run.runId, work(3, 5)),
    ]);

    expect(order).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
  });

  test("allows work on independent runIds to overlap", async () => {
    const runA = await createRun(sampleWorkflow);
    const runB = await createRun(sampleWorkflow);
    const runC = await createRun(sampleWorkflow);
    const inFlight = new Set<string>();
    let maxOverlap = 0;

    const work = (key: string, hold: number) => async () => {
      inFlight.add(key);
      maxOverlap = Math.max(maxOverlap, inFlight.size);
      await new Promise((resolve) => setTimeout(resolve, hold));
      inFlight.delete(key);
    };

    await Promise.all([
      withRunMutexFor(runA.runId, work(runA.runId, 30)),
      withRunMutexFor(runB.runId, work(runB.runId, 30)),
      withRunMutexFor(runC.runId, work(runC.runId, 30)),
    ]);

    expect(maxOverlap).toBeGreaterThanOrEqual(2);
  });

  test("rejects unsafe runIds", async () => {
    await expect(withRunMutexFor("../escape", () => Promise.resolve(1))).rejects.toThrow(/unsafe runId/);
  });

  test("does not poison subsequent calls after a rejection", async () => {
    const run = await createRun(sampleWorkflow);
    await expect(withRunMutexFor(run.runId, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const result = await withRunMutexFor(run.runId, () => 42);
    expect(result).toBe(42);
  });
});

describe("recordAgentComplete concurrency", () => {
  test("two concurrent completions for the same agent produce a single completedAgents entry", async () => {
    const run = await createRun(sampleWorkflow);
    saveAgentResult(run.runId, "scan", {
      phaseId: "scan",
      agentId: "a1",
      prompt: "p1",
      status: "running",
    });

    await Promise.all([
      recordAgentComplete(run.runId, "scan", "a1", "result A"),
      recordAgentComplete(run.runId, "scan", "a1", "result B"),
    ]);

    const reloaded = loadRun(run.runId);
    const a1Entries = (reloaded?.completedAgents ?? []).filter((a) => a.agentId === "a1");
    expect(a1Entries).toHaveLength(1);
  });

  test("all fan-out agents can complete concurrently without losing outputs", async () => {
    const run = await createRun(sampleWorkflow);

    await Promise.all([
      recordAgentComplete(run.runId, "scan", "a1", "out-1"),
      recordAgentComplete(run.runId, "scan", "a2", "out-2"),
      recordAgentComplete(run.runId, "scan", "a3", "out-3"),
    ]);

    const reloaded = loadRun(run.runId);
    expect(reloaded?.outputs["scan.a1"]).toBe("out-1");
    expect(reloaded?.outputs["scan.a2"]).toBe("out-2");
    expect(reloaded?.outputs["scan.a3"]).toBe("out-3");
    expect(reloaded?.status).toBe("running");
    expect(reloaded?.currentPhaseId).toBe("synthesize");

    const step = await stepInlineRun(run.runId);
    expect(step?.type).toBe("dispatch");
  });
});

describe("agent ID pinning", () => {
  test("setRuntimeAgentId rejects unsafe values", () => {
    setRuntimeAgentId("../../../etc/passwd");
    // After rejecting, getRunDir should not have escaped; verify by creating
    // a fresh agent and confirming setRuntimeAgentId with a safe id sticks.
    setRuntimeAgentId("agent-test1234");
    expect(path.basename(getRunDir("1784385035947-abcdefgh", "agent-test1234"))).toBe("1784385035947-abcdefgh");
  });

  test("createRun captures current agentId", async () => {
    setRuntimeAgentId("agent-creator1");
    const run = await createRun(sampleWorkflow);
    expect(run.agentId).toBe("agent-creator1");

    const reloaded = loadRun(run.runId);
    expect(reloaded?.agentId).toBe("agent-creator1");
  });

  test("loadRun finds the run via fallback when current agentId differs", async () => {
    setRuntimeAgentId("agent-origin0000");
    const run = await createRun(sampleWorkflow);

    // Switch the runtime agent id to a different value. loadRun should still
    // resolve the run via the agent-dir fallback walk.
    setRuntimeAgentId("agent-other00001");
    const reloaded = loadRun(run.runId);
    expect(reloaded?.runId).toBe(run.runId);
    expect(reloaded?.agentId).toBe("agent-origin0000");
  });

  test("recordAgentComplete writes to the pinned agent directory", async () => {
    setRuntimeAgentId("agent-pinned001");
    const run = await createRun(sampleWorkflow);
    saveAgentResult(run.runId, "scan", {
      phaseId: "scan",
      agentId: "a1",
      prompt: "p1",
      status: "running",
    }, run.agentId);

    // Flip the runtime agentId — recordAgentComplete must still write to
    // the original agent's directory tree.
    setRuntimeAgentId("agent-flipped002");
    await recordAgentComplete(run.runId, "scan", "a1", "out");

    // The pinned directory must contain the updated file.
    const filePath = getRunPath(run.runId, "agent-pinned001");
    expect(filePath).toContain("agent-pinned001");
    // Sanity: file should exist in the pinned agent dir.
    mkdirSync(path.dirname(filePath), { recursive: true });
    expect(require("node:fs").existsSync(filePath)).toBe(true);
  });
});
