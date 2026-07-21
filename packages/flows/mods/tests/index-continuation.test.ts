import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import activate from "../index.ts";
import { createRun, getRunResultPath, loadRun } from "../lib/state.ts";
import { WORKFLOW_VERSION, type WorkflowDefinition } from "../lib/schema.ts";

let originalLettaHome: string | undefined;
let originalLettaAgentId: string | undefined;
let tempDir: string;

beforeEach(() => {
  originalLettaHome = process.env.LETTA_HOME;
  originalLettaAgentId = process.env.LETTA_AGENT_ID;
  tempDir = mkdtempSync(path.join(tmpdir(), "flows-continuation-"));
  process.env.LETTA_HOME = tempDir;
  process.env.LETTA_AGENT_ID = "agent-backend0001";
});

afterEach(() => {
  if (originalLettaHome === undefined) delete process.env.LETTA_HOME;
  else process.env.LETTA_HOME = originalLettaHome;
  if (originalLettaAgentId === undefined) delete process.env.LETTA_AGENT_ID;
  else process.env.LETTA_AGENT_ID = originalLettaAgentId;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("same-turn flow continuation", () => {
  test("advances fan-out and barrier through tool_end results", async () => {
    let flowCommand: any;
    let toolEnd: any;

    const dispose = activate({
      capabilities: { commands: true, events: { tools: true } },
      commands: {
        register(definition: any) {
          flowCommand = definition;
          return () => {};
        },
      },
      events: {
        on(event: string, handler: any) {
          if (event === "tool_end") toolEnd = handler;
          return () => {};
        },
      },
    } as any);

    const conversation = { id: "conversation-1" };
    const ownerAgentId = "agent-parent0001";
    const commandResult = await flowCommand.run({
      args: "run code-audit",
      cwd: "/tmp/project",
      conversation,
      agent: { id: ownerAgentId },
      model: { id: "openai/gpt-test" },
    });
    expect(commandResult.type).toBe("prompt");

    const runId = String(commandResult.content).match(/Run ID: (\d{13,}-[A-Za-z0-9]{8,})/)?.[1];
    expect(runId).toBeTruthy();
    if (!runId) return;

    const eventContext = { conversation, agent: { id: ownerAgentId } };
    const resultFor = (agentId: string, output: string) => toolEnd({
      toolName: "Agent",
      status: "success",
      args: {
        prompt: `scan\n[FLOW_AGENT run_id=${runId} phase_id=scan agent_id=${agentId}]`,
      },
      output,
    }, eventContext);

    // Three of four scan agents complete without advancing the phase.
    expect(await resultFor("concurrency", "concurrency report")).toBeUndefined();
    expect(await resultFor("nullability", "nullability report")).toBeUndefined();
    expect(await resultFor("security", "security report")).toBeUndefined();
    // The fourth scan agent advances to the verify barrier.
    const fanOutCompletion = await resultFor("reliability", "reliability report");
    expect(fanOutCompletion.result.status).toBe("success");
    expect(fanOutCompletion.result.output).toContain("[FLOW CONTINUATION]");
    expect(fanOutCompletion.result.output).toContain("agent_id=synthesize");
    expect(fanOutCompletion.result.output).not.toContain("sendMessageStream");

    // Verify barrier completes and advances to the report barrier.
    const verifyCompletion = await toolEnd({
      toolName: "Agent",
      status: "success",
      args: {
        prompt: `verify\n[FLOW_AGENT run_id=${runId} phase_id=verify agent_id=synthesize]`,
      },
      output: "structured verification ledger",
    }, eventContext);
    expect(verifyCompletion.result.status).toBe("success");
    expect(verifyCompletion.result.output).toContain("[FLOW CONTINUATION]");

    // Report barrier completes and the flow finishes.
    const barrierCompletion = await toolEnd({
      toolName: "Agent",
      status: "success",
      args: {
        prompt: `report\n[FLOW_AGENT run_id=${runId} phase_id=report agent_id=synthesize]`,
      },
      output: "final advisory report",
    }, eventContext);
    expect(barrierCompletion.result.status).toBe("success");
    expect(barrierCompletion.result.output).toContain("[FLOW COMPLETE]");
    expect(barrierCompletion.result.output).toContain("final advisory report");

    const resultPath = getRunResultPath(runId, ownerAgentId);
    expect(readFileSync(resultPath, "utf8")).toBe("final advisory report");

    dispose();
  });

  test("returns one Auto retry before terminally failing an Agent", async () => {
    let flowCommand: any;
    let toolEnd: any;
    const dispose = activate({
      capabilities: { commands: true, events: { tools: true } },
      commands: {
        register(definition: any) {
          flowCommand = definition;
          return () => {};
        },
      },
      events: {
        on(event: string, handler: any) {
          if (event === "tool_end") toolEnd = handler;
          return () => {};
        },
      },
    } as any);

    const conversation = { id: "conversation-1" };
    const ownerAgentId = "agent-parent0001";
    const commandResult = await flowCommand.run({
      args: "run code-audit",
      cwd: "/tmp/project",
      conversation,
      agent: { id: ownerAgentId },
      model: { id: "openai/gpt-test" },
    });
    const runId = String(commandResult.content).match(/Run ID: (\d{13,}-[A-Za-z0-9]{8,})/)?.[1];
    expect(runId).toBeTruthy();
    if (!runId) return;

    const prompt = `scan\n[FLOW_AGENT run_id=${runId} phase_id=scan agent_id=concurrency]`;
    const retry = await toolEnd({
      toolName: "Agent",
      status: "error",
      args: { prompt, model: "openai/gpt-test" },
      output: "preferred model unavailable",
    }, { conversation, agent: { id: ownerAgentId } });
    expect(retry.result.status).toBe("error");
    expect(retry.result.output).toContain("[FLOW RETRY]");
    expect(loadRun(runId)?.status).toBe("running");

    const failed = await toolEnd({
      toolName: "Agent",
      status: "error",
      args: { prompt },
      output: "Auto launch failed",
    }, { conversation, agent: { id: ownerAgentId } });
    expect(failed.result.status).toBe("error");
    expect(failed.result.output).toContain("[FLOW FAILED]");
    expect(loadRun(runId)?.status).toBe("failed");

    dispose();
  });

  test("keeps flow_status read-only", async () => {
    let flowStatus: any;
    const dispose = activate({
      capabilities: { tools: true },
      tools: {
        register(definition: any) {
          if (definition.name === "flow_status") flowStatus = definition;
          return () => {};
        },
      },
      events: { on: () => () => {} },
    } as any);

    const workflow = {
      name: "status-test",
      version: WORKFLOW_VERSION,
      description: "Verify read-only status.",
      phases: [{
        id: "scan",
        type: "fan-out" as const,
        agents: [{ id: "a1", prompt: "scan" }],
      }],
    } satisfies WorkflowDefinition;
    const run = await createRun(workflow, {}, "conversation-1", "/tmp/project", undefined, "agent-parent0001");
    expect(loadRun(run.runId)?.startedAgentIds).toEqual([]);

    const status = await flowStatus.run({ args: { run_id: run.runId } });
    expect(status.status).toBe("success");
    expect(status.step).toBeUndefined();
    expect(loadRun(run.runId)?.startedAgentIds).toEqual([]);

    dispose();
  });
});
