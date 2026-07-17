import type { RunState, AgentRunState } from "./state.ts";
import {
  type FanOutPhase,
  type BarrierPhase,
  isFanOutPhase,
  isBarrierPhase,
  phaseById,
  isPhaseComplete,
  nextPhase,
  getPhaseMaxConcurrent,
} from "./schema.ts";
import {
  loadRun,
  loadAgentResult,
  saveAgentResult,
  persistRun,
  updateRunRegistry,
  saveRunResult,
  touchRun,
  loadRunResult,
} from "./state.ts";

export interface InlineDispatch {
  type: "dispatch";
  runId: string;
  phaseId: string;
  phaseType: "fan-out" | "barrier";
  instructions: string;
  agents?: Array<{ id: string; prompt: string; model?: string } >;
}

export interface InlineComplete {
  type: "complete";
  runId: string;
  result: string;
  resultPath: string;
}

export interface InlineWait {
  type: "wait";
  runId: string;
  phaseId: string;
  pending: number;
  completed: number;
}

export type InlineStep = InlineDispatch | InlineComplete | InlineWait;

export function stepInlineRun(runId: string): InlineStep | null {
  const run = loadRun(runId);
  if (!run) return null;
  if (run.status === "completed") {
    const result = loadRunResult(runId) ?? "";
    return { type: "complete", runId, result, resultPath: `~/.letta/workflows/runs/${runId}/result.md` };
  }
  if (run.status !== "running") {
    return null;
  }

  const currentPhaseId = run.currentPhaseId;
  if (!currentPhaseId) {
    return completeRun(run, "No phases remaining.");
  }

  const phase = phaseById(run.workflow, currentPhaseId);
  if (!phase) {
    run.status = "failed";
    run.error = `Unknown phase "${currentPhaseId}".`;
    persistRun(touchRun(run));
    updateRunRegistry(run);
    return null;
  }

  if (isFanOutPhase(phase)) {
    return dispatchFanOut(run, phase);
  }

  if (isBarrierPhase(phase)) {
    return dispatchBarrier(run, phase);
  }

  return null;
}

export function recordAgentComplete(runId: string, phaseId: string, agentId: string, output: string): RunState | null {
  const run = loadRun(runId);
  if (!run) return null;
  const phase = phaseById(run.workflow, phaseId);
  if (!phase || !isFanOutPhase(phase)) return null;

  const agent = phase.agents.find((a) => a.id === agentId);
  if (!agent) return null;

  const existing = loadAgentResult(runId, phaseId, agentId);
  const state: AgentRunState = existing
    ? { ...existing, status: "completed", output, completedAt: new Date().toISOString() }
    : {
        phaseId,
        agentId,
        prompt: agent.prompt,
        status: "completed",
        output,
        completedAt: new Date().toISOString(),
      };
  saveAgentResult(runId, phaseId, state);

  run.completedAgents = run.completedAgents.filter((a) => !(a.phaseId === phaseId && a.agentId === agentId));
  run.completedAgents.push(state);

  run.outputs[`${phaseId}.${agentId}`] = output;

  const completedAgentIds = new Set(run.completedAgents.map((a) => a.agentId));
  if (isPhaseComplete(run.workflow, phaseId, completedAgentIds)) {
    advancePhase(run);
  }

  persistRun(touchRun(run));
  updateRunRegistry(run);
  return run;
}

export function recordBarrierComplete(runId: string, phaseId: string, output: string): RunState | null {
  const run = loadRun(runId);
  if (!run) return null;
  const phase = phaseById(run.workflow, phaseId);
  if (!phase || !isBarrierPhase(phase)) return null;

  run.outputs[phaseId] = output;
  advancePhase(run);
  persistRun(touchRun(run));
  updateRunRegistry(run);
  return run;
}

function dispatchFanOut(run: RunState, phase: FanOutPhase): InlineDispatch | InlineWait {
  const completedIds = new Set(run.completedAgents.map((a) => a.agentId));
  const pendingAgents = phase.agents.filter((a) => !completedIds.has(a.id));

  if (pendingAgents.length === 0) {
    advancePhase(run);
    persistRun(touchRun(run));
    updateRunRegistry(run);
    return stepInlineRun(run.runId) as InlineDispatch | InlineWait;
  }

  const concurrency = getPhaseMaxConcurrent(phase, run.workflow.budgets);
  const dispatchNow = pendingAgents.slice(0, concurrency);
  const remaining = pendingAgents.length - dispatchNow.length;

  return {
    type: "dispatch",
    runId: run.runId,
    phaseId: phase.id,
    phaseType: "fan-out",
    instructions: `Dispatch ${dispatchNow.length} parallel Agent tool call(s) for phase "${phase.id}". ${remaining > 0 ? `${remaining} agent(s) will queue after the first batch completes.` : ""}`,
    agents: dispatchNow.map((a) => ({ id: a.id, prompt: a.prompt, model: phase.model })),
  };
}

function dispatchBarrier(run: RunState, phase: BarrierPhase): InlineDispatch {
  const inputs = phase.depends_on.map((depId) => {
    const dep = phaseById(run.workflow, depId);
    if (!dep) return { phaseId: depId, outputs: {} };
    if (isFanOutPhase(dep)) {
      const outputs: Record<string, string> = {};
      for (const agent of dep.agents) {
        const key = `${depId}.${agent.id}`;
        if (run.outputs[key]) outputs[agent.id] = String(run.outputs[key]);
      }
      return { phaseId: depId, outputs };
    }
    return { phaseId: depId, outputs: { result: String(run.outputs[depId] ?? "") } };
  });

  const synthesizedPrompt = `${phase.prompt}

Inputs from prior phases:
${JSON.stringify(inputs, null, 2)}`;

  return {
    type: "dispatch",
    runId: run.runId,
    phaseId: phase.id,
    phaseType: "barrier",
    instructions: `Dispatch a single Agent (or fork) to synthesize the outputs from prior phases.`,
    agents: [{ id: "synthesize", prompt: synthesizedPrompt, model: phase.model }],
  };
}

function advancePhase(run: RunState): void {
  const completedIds = new Set(run.completedPhaseIds);
  if (run.currentPhaseId) completedIds.add(run.currentPhaseId);
  run.completedPhaseIds = Array.from(completedIds);

  const next = nextPhase(run.workflow, completedIds);
  if (next) {
    run.currentPhaseId = next.id;
  } else {
    run.currentPhaseId = null;
    run.status = "completed";
  }
}

function completeRun(run: RunState, result: string): InlineComplete {
  run.status = "completed";
  run.currentPhaseId = null;
  persistRun(touchRun(run));
  updateRunRegistry(run);
  saveRunResult(run.runId, result);
  return {
    type: "complete",
    runId: run.runId,
    result,
    resultPath: `~/.letta/workflows/runs/${run.runId}/result.md`,
  };
}
