import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import activate from "../index.ts";
import { getRunResultPath } from "../lib/state.ts";

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

    expect(await resultFor("race", "race report")).toBeUndefined();
    expect(await resultFor("null", "null report")).toBeUndefined();
    const fanOutCompletion = await resultFor("inject", "inject report");
    expect(fanOutCompletion.result.status).toBe("success");
    expect(fanOutCompletion.result.output).toContain("[FLOW CONTINUATION]");
    expect(fanOutCompletion.result.output).toContain("agent_id=synthesize");
    expect(fanOutCompletion.result.output).not.toContain("sendMessageStream");

    const barrierCompletion = await toolEnd({
      toolName: "Agent",
      status: "success",
      args: {
        prompt: `synthesize\n[FLOW_AGENT run_id=${runId} phase_id=synthesize agent_id=synthesize]`,
      },
      output: "final synthesized report",
    }, eventContext);
    expect(barrierCompletion.result.status).toBe("success");
    expect(barrierCompletion.result.output).toContain("[FLOW COMPLETE]");
    expect(barrierCompletion.result.output).toContain("final synthesized report");

    const resultPath = getRunResultPath(runId, ownerAgentId);
    expect(readFileSync(resultPath, "utf8")).toBe("final synthesized report");

    dispose();
  });
});
