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
  withRunMutex,
  loadRun,
  loadAgentResult,
  saveAgentResult,
  persistRun,
  updateRunRegistry,
  saveRunResult,
  touchRun,
  readRunResult,
  readRunAgentOutput,
  getRunAgentOutputPath,
  getRunResultPath,
  getRunResultDisplayPath,
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

export async function stepInlineRun(runId: string): Promise<InlineStep | null> {
  const run = loadRun(runId);
  if (!run) return null;
  if (run.status === "completed") {
    const result = readRunResult(runId) ?? "";
    return { type: "complete", runId, result, resultPath: getRunResultDisplayPath(runId) };
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

export async function recordAgentComplete(runId: string, phaseId: string, agentId: string, output: string): Promise<RunState | null> {
  return withRunMutex(async () => {
    const run = loadRun(runId);
    if (!run) return null;
    const phase = phaseById(run.workflow, phaseId);
    if (!phase || !isFanOutPhase(phase)) return null;

    const agent = phase.agents.find((a) => a.id === agentId);
    if (!agent) return null;

    const fileOutput = readRunAgentOutput(runId, phaseId, agentId);
    const finalOutput = fileOutput ?? output;

    const existing = loadAgentResult(runId, phaseId, agentId);
    const state: AgentRunState = existing
      ? { ...existing, status: "completed", output: finalOutput, completedAt: new Date().toISOString() }
      : {
          phaseId,
          agentId,
          prompt: agent.prompt,
          status: "completed",
          output: finalOutput,
          completedAt: new Date().toISOString(),
        };

    // Only write the file if the agent did not already write it. If the agent
    // produced a detailed report, preserving that is more valuable than the
    // short tool-return placeholder.
    if (!fileOutput) {
      saveAgentResult(runId, phaseId, state);
    }

    run.completedAgents = run.completedAgents.filter((a) => !(a.phaseId === phaseId && a.agentId === agentId));
    run.completedAgents.push(state);

    run.outputs[`${phaseId}.${agentId}`] = finalOutput;

    const completedAgentIds = new Set(run.completedAgents.map((a) => a.agentId));
    if (isPhaseComplete(run.workflow, phaseId, completedAgentIds)) {
      advancePhase(run);
    }

    persistRun(touchRun(run));
    updateRunRegistry(run);
    return run;
  });
}

export async function recordBarrierComplete(runId: string, phaseId: string, output: string): Promise<RunState | null> {
  return withRunMutex(async () => {
    const run = loadRun(runId);
    if (!run) return null;
    const phase = phaseById(run.workflow, phaseId);
    if (!phase || !isBarrierPhase(phase)) return null;

    run.outputs[phaseId] = output;
    advancePhase(run);
    if (run.status === "completed") {
      const complete = completeRun(run, output);
      if (complete.error) {
        run.status = "failed";
        run.error = complete.error;
        persistRun(touchRun(run));
        updateRunRegistry(run);
        return null;
      }
      return run;
    }
    persistRun(touchRun(run));
    updateRunRegistry(run);
    return run;
  });
}

async function dispatchFanOut(run: RunState, phase: FanOutPhase): Promise<InlineStep | null> {
  const completedIds = new Set(run.completedAgents.map((a) => a.agentId));
  const pendingAgents = phase.agents.filter((a) => !completedIds.has(a.id) && !run.startedAgentIds.includes(a.id));

  if (pendingAgents.length === 0) {
    const runningAgents = phase.agents.filter((a) => run.startedAgentIds.includes(a.id) && !completedIds.has(a.id));
    for (const a of runningAgents) {
      const fileOutput = readRunAgentOutput(run.runId, phase.id, a.id);
      if (fileOutput && fileOutput.length > 0) {
        await recordAgentComplete(run.runId, phase.id, a.id, fileOutput);
      }
    }
    const refreshed = loadRun(run.runId);
    if (refreshed && isPhaseComplete(refreshed.workflow, phase.id, new Set(refreshed.completedAgents.map((a) => a.agentId)))) {
      advancePhase(refreshed);
      persistRun(touchRun(refreshed));
      updateRunRegistry(refreshed);
      return stepInlineRun(refreshed.runId);
    }
    const remaining = runningAgents.length;
    const done = phase.agents.length - remaining;
    return { type: "wait", runId: run.runId, phaseId: phase.id, pending: remaining, completed: done };
  }

  const concurrency = getPhaseMaxConcurrent(phase, run.workflow.budgets);
  const dispatchNow = pendingAgents.slice(0, concurrency);
  const remaining = phase.agents.length - completedIds.size - dispatchNow.length;

  for (const a of dispatchNow) {
    if (!run.startedAgentIds.includes(a.id)) {
      run.startedAgentIds.push(a.id);
    }
  }
  persistRun(touchRun(run));
  updateRunRegistry(run);

  return {
    type: "dispatch",
    runId: run.runId,
    phaseId: phase.id,
    phaseType: "fan-out",
    instructions: `Dispatch ${dispatchNow.length} parallel Agent tool call(s) for phase "${phase.id}". ${remaining > 0 ? `${remaining} agent(s) will queue after the first batch completes.` : ""}`,
    agents: dispatchNow.map((a) => ({
      id: a.id,
      prompt: `${a.prompt}\n\nWhen you are done, write your complete findings to ${getRunAgentOutputPath(run.runId, phase.id, a.id)}.`,
      model: phase.model,
    })),
  };
}

async function dispatchBarrier(run: RunState, phase: BarrierPhase): Promise<InlineStep | null> {
  const inputs = phase.depends_on.map((depId) => {
    const dep = phaseById(run.workflow, depId);
    if (!dep) return { phaseId: depId, outputs: {} };
    if (isFanOutPhase(dep)) {
      const outputs: Record<string, string> = {};
      for (const agent of dep.agents) {
        const filePath = getRunAgentOutputPath(run.runId, depId, agent.id);
        const fileOutput = readRunAgentOutput(run.runId, depId, agent.id);
        outputs[agent.id] = fileOutput
          ? `Read the full report from ${filePath}:\n\n${fileOutput}`
          : String(run.outputs[`${depId}.${agent.id}`] ?? "");
      }
      return { phaseId: depId, outputs };
    }
    return { phaseId: depId, outputs: { result: String(run.outputs[depId] ?? "") } };
  });

  const missingReports = phase.depends_on.flatMap((depId) => {
    const dep = phaseById(run.workflow, depId);
    if (!dep || !isFanOutPhase(dep)) return [];
    return dep.agents
      .filter((a) => {
        const text = readRunAgentOutput(run.runId, depId, a.id);
        return !text || text.length === 0;
      })
      .map((a) => `${depId}.${a.id}`);
  });

  if (missingReports.length > 0) {
    return {
      type: "wait",
      runId: run.runId,
      phaseId: phase.id,
      pending: missingReports.length,
      completed: 0,
    };
  }

  if (run.startedPhaseIds.includes(phase.id)) {
    const fileResult = readRunResult(run.runId);
    if (fileResult && fileResult.length > 0) {
      await recordBarrierComplete(run.runId, phase.id, fileResult);
      const refreshed = loadRun(run.runId);
      if (refreshed?.status === "completed") {
        return { type: "complete", runId: run.runId, result: fileResult, resultPath: getRunResultDisplayPath(run.runId) };
      }
      return stepInlineRun(run.runId);
    }
    return { type: "wait", runId: run.runId, phaseId: phase.id, pending: 1, completed: 0 };
  }

  run.startedPhaseIds.push(phase.id);
  persistRun(touchRun(run));
  updateRunRegistry(run);

  const resultPath = getRunResultPath(run.runId);
  const synthesizedPrompt = `${phase.prompt}

Inputs from prior phases (read from the full .md reports where available):
${JSON.stringify(inputs, null, 2)}

When you are done, write your final synthesized report to ${resultPath}.`;

  return {
    type: "dispatch",
    runId: run.runId,
    phaseId: phase.id,
    phaseType: "barrier",
    instructions: `Dispatch a single Agent to synthesize the outputs from prior phases.`,
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

function completeRun(run: RunState, result: string): InlineComplete & { error?: string } {
  run.status = "completed";
  run.currentPhaseId = null;
  // If a barrier agent was instructed to write result.md, prefer that file.
  const fileResult = readRunResult(run.runId);
  const finalResult = fileResult ?? result;
  persistRun(touchRun(run));
  updateRunRegistry(run);
  try {
    saveRunResult(run.runId, finalResult);
  } catch (err) {
    return {
      type: "complete",
      runId: run.runId,
      result: finalResult,
      resultPath: getRunResultDisplayPath(run.runId),
      error: String(err),
    };
  }
  return {
    type: "complete",
    runId: run.runId,
    result: finalResult,
    resultPath: getRunResultDisplayPath(run.runId),
  };
}
