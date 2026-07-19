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
  withRunMutexFor,
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

export function parseFlowAgentMarker(prompt: unknown): { runId: string; phaseId: string; agentId: string } | null {
  if (typeof prompt !== "string") return null;
  // Tight captures to match isSafeIdentifier / isSafeRunId invariants. The
  // marker must appear at the end of the prompt so a malicious workflow
  // author cannot embed a spoofed marker inside a.prompt / phase.prompt to
  // redirect completion routing. Closes M-A from sweep 6.
  const match = prompt.match(/\[FLOW_AGENT run_id=(\d{13,}-[A-Za-z0-9]{8,}) phase_id=([A-Za-z0-9_-]{1,64}) agent_id=([A-Za-z0-9_-]{1,64})\]\s*$/);
  if (!match) return null;
  return { runId: match[1], phaseId: match[2], agentId: match[3] };
}

// Sanitize a value before interpolation into a sub-agent prompt. Strips
// ASCII control characters and Unicode line/paragraph separators, mirrors
// sanitizeWorkingDirectory but stricter (also collapses embedded [FLOW_AGENT
// markers so a workflow author cannot spoof a routing marker). Closes M-A
// (marker spoofing) and H-C (phase.model control chars).
export function sanitizePromptField(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  let cleaned = value.replace(/[\x00-\x1F\x7F\u2028\u2029]/g, "");
  // Strip embedded [FLOW_AGENT markers that could be mis-parsed. Replace
  // them with a benign placeholder so length is preserved for debugging.
  cleaned = cleaned.replace(/\[FLOW_AGENT[^\]]*\]/g, "[FLOW_AGENT_REDACTED]");
  return cleaned.length > 0 ? cleaned : undefined;
}

export interface InlineDispatch {
  type: "dispatch";
  runId: string;
  phaseId: string;
  phaseType: "fan-out" | "barrier";
  instructions: string;
  agents?: Array<{ id: string; prompt: string; model?: string }>;
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

// ---------------------------------------------------------------------------
// Locking contract.
//
// All three public functions (stepInlineRun, recordAgentComplete,
// recordBarrierComplete) acquire the per-run mutex via withRunMutexFor before
// touching run state. They then delegate to a `*Locked` helper that ASSUMES
// the caller already holds the mutex.
//
// This split closes C1 (deterministic deadlock under refactor): when
// dispatchFanOut / dispatchBarrier call into recordAgentCompleteLocked /
// recordBarrierCompleteLocked / stepInlineRunLocked directly, no second
// acquisition happens, so the runner is safe regardless of how the
// withRunMutexFor implementation schedules its callback.
//
// Public entry points stay the same; the change is purely structural.
// ---------------------------------------------------------------------------

export function stepInlineRun(runId: string): Promise<InlineStep | null> {
  return withRunMutexFor(runId, () => stepInlineRunLocked(runId));
}

export async function recordAgentComplete(runId: string, phaseId: string, agentId: string, output: string): Promise<RunState | null> {
  return withRunMutexFor(runId, () => recordAgentCompleteLocked(runId, phaseId, agentId, output));
}

export async function recordBarrierComplete(runId: string, phaseId: string, output: string): Promise<InlineComplete | RunState | null> {
  return withRunMutexFor(runId, () => recordBarrierCompleteLocked(runId, phaseId, output));
}

// Internal: assumes caller holds the per-run mutex. Reads run state from
// disk, advances the run, and returns the next inline step. Used by both
// stepInlineRun (public) and dispatchFanOut/dispatchBarrier (after they
// mutate run state inside their own mutex slot). Exported for tests; the
// public API is stepInlineRun.
export function stepInlineRunLocked(runId: string): InlineStep | null {
  const run = loadRun(runId);
  if (!run) return null;
  if (run.status === "completed") {
    const result = readRunResult(runId, run.agentId) ?? "";
    return { type: "complete", runId, result, resultPath: getRunResultDisplayPath(runId, run.agentId) };
  }
  if (run.status !== "running") {
    return null;
  }

  const currentPhaseId = run.currentPhaseId;
  if (!currentPhaseId) {
    return completeRunLocked(run, "No phases remaining.");
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
    return dispatchFanOutLocked(run, phase);
  }

  if (isBarrierPhase(phase)) {
    return dispatchBarrierLocked(run, phase);
  }

  return null;
}

// Internal: assumes caller holds the per-run mutex. Reads the run from disk,
// mutates it to record the agent completion, and returns the run. Used by
// both recordAgentComplete (public) and the late-pickup branch in
// dispatchFanOutLocked. Exported for tests; the public API is
// recordAgentComplete.
export function recordAgentCompleteLocked(runId: string, phaseId: string, agentId: string, output: string): RunState | null {
  const run = loadRun(runId);
  if (!run) return null;
  if (run.status !== "running") return run;
  const phase = phaseById(run.workflow, phaseId);
  if (!phase || !isFanOutPhase(phase)) return run;

  const agent = phase.agents.find((a) => a.id === agentId);
  if (!agent) return run;

  // If this agent has already been recorded as completed, treat this call
  // as a no-op. Concurrent tool_end deliveries from subagents and the late
  // pickup branch in dispatchFanOut can both arrive for the same agent.
  const alreadyDone = run.completedAgents.some((a) => a.phaseId === phaseId && a.agentId === agentId);
  if (alreadyDone) return run;

  const fileOutput = readRunAgentOutput(runId, phaseId, agentId, run.agentId);
  const finalOutput = fileOutput ?? output;

  const existing = loadAgentResult(runId, phaseId, agentId, run.agentId);
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
    saveAgentResult(runId, phaseId, state, run.agentId);
  }

  run.completedAgents = run.completedAgents.filter((a) => !(a.phaseId === phaseId && a.agentId === agentId));
  run.completedAgents.push(state);

  run.outputs[`${phaseId}.${agentId}`] = finalOutput;

  const completedAgentIds = new Set(run.completedAgents.map((a) => a.agentId));
  if (isPhaseComplete(run.workflow, phaseId, completedAgentIds, new Set(run.completedPhaseIds))) {
    advancePhase(run);
  }

  persistRun(touchRun(run));
  updateRunRegistry(run);
  return run;
}

// Internal: assumes caller holds the per-run mutex. Exported for tests; the
// public API is recordBarrierComplete.
export function recordBarrierCompleteLocked(runId: string, phaseId: string, output: string): InlineComplete | RunState | null {
  const run = loadRun(runId);
  if (!run) return null;
  if (run.status !== "running") return run;
  const phase = phaseById(run.workflow, phaseId);
  if (!phase || !isBarrierPhase(phase)) return run;
  // H1 from sweep 7: idempotency guard. A delayed/duplicate tool_end for an
  // earlier barrier can land after the run has advanced to a later phase;
  // without this guard we'd advance the wrong phase and mark the run as
  // completing the stale barrier instead of the current one.
  if (run.currentPhaseId !== phaseId) return run;
  if (run.completedPhaseIds.includes(phaseId)) return run;

  run.outputs[phaseId] = output;
  advancePhase(run);
  if ((run.status as RunState["status"]) === "completed") {
    const complete = completeRunLocked(run, output);
    if (complete.error) {
      // H-5 from sweep 8: completeRunLocked already persisted successfully
      // with status="completed" before saveRunResult threw. Don't re-persist
      // — that would silently overwrite the durable "completed" state with
      // "failed". Surface the error via the run's `error` field and let the
      // orchestrator decide what to do (typically retry or report).
      run.error = complete.error;
      persistRun(touchRun(run));
      return null;
    }
    return complete;
  }
  persistRun(touchRun(run));
  updateRunRegistry(run);
  return run;
}

function dispatchFanOutLocked(run: RunState, phase: FanOutPhase): InlineStep | null {
  const completedIds = new Set(run.completedAgents.map((a) => a.agentId));
  const pendingAgents = phase.agents.filter((a) => !completedIds.has(a.id) && !run.startedAgentIds.includes(a.id));

  // Sweep-11 M-4 fix: a fan-out phase with zero agents would otherwise
  // silently loop in the late-pickup branch below, returning {pending: 0,
  // completed: 0} forever until the budget ceiling fires. Surface the
  // malformed workflow as a terminal failure instead. The schema's
  // `validateWorkflow` already rejects `agents: []` at parse time, so this
  // is a defense-in-depth guard for workflows constructed directly
  // bypassing the schema (e.g. from tests or programmatic creation).
  if (phase.agents.length === 0) {
    run.status = "failed";
    run.error = `Fan-out phase "${phase.id}" has no agents defined.`;
    persistRun(touchRun(run));
    updateRunRegistry(run);
    return null;
  }

  if (pendingAgents.length === 0) {
    const runningAgents = phase.agents.filter((a) => run.startedAgentIds.includes(a.id) && !completedIds.has(a.id));
    for (const a of runningAgents) {
      const fileOutput = readRunAgentOutput(run.runId, phase.id, a.id, run.agentId);
      if (fileOutput && fileOutput.length > 0) {
        // Call the locked variant: caller (this function) is already inside
        // the per-run mutex slot via stepInlineRunLocked, so no re-acquire.
        recordAgentCompleteLocked(run.runId, phase.id, a.id, fileOutput);
      }
    }
    const refreshed = loadRun(run.runId);
    // Guard against double-advance: if a concurrent recordAgentComplete
    // already moved past this phase, refreshed.currentPhaseId is no longer
    // phase.id. Skip the advance and re-step. Closes H-B from sweep 6.
    if (refreshed
        && refreshed.currentPhaseId === phase.id
        && isPhaseComplete(refreshed.workflow, phase.id, new Set(refreshed.completedAgents.map((a) => a.agentId)), new Set(refreshed.completedPhaseIds))) {
      advancePhase(refreshed);
      persistRun(touchRun(refreshed));
      updateRunRegistry(refreshed);
      // Step inline using the locked variant to avoid re-acquiring the mutex
      // we already hold.
      return stepInlineRunLocked(refreshed.runId);
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
      prompt: `${sanitizePromptField(a.prompt) ?? ""}\n\nWorking directory: ${run.workingDirectory ?? "the current project directory"}\n${phase.model ? `Use model: ${sanitizePromptField(phase.model) ?? ""}\n` : ""}When you are done, write your complete findings to ${getRunAgentOutputPath(run.runId, phase.id, a.id, run.agentId)}.\n\n[FLOW_AGENT run_id=${run.runId} phase_id=${phase.id} agent_id=${a.id}]`,
      model: phase.model,
    })),
  };
}

function dispatchBarrierLocked(run: RunState, phase: BarrierPhase): InlineStep | null {
  const inputs = phase.depends_on.map((depId) => {
    const dep = phaseById(run.workflow, depId);
    if (!dep) return { phaseId: depId, outputs: {} };
    if (isFanOutPhase(dep)) {
      const outputs: Record<string, string> = {};
      for (const agent of dep.agents) {
        const filePath = getRunAgentOutputPath(run.runId, depId, agent.id, run.agentId);
        const fileOutput = readRunAgentOutput(run.runId, depId, agent.id, run.agentId);
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
        const text = readRunAgentOutput(run.runId, depId, a.id, run.agentId);
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
    const fileResult = readRunResult(run.runId, run.agentId);
    if (fileResult && fileResult.length > 0) {
      // H1/H2 fix: use the result returned by recordBarrierCompleteLocked
      // directly instead of re-loading the run from disk. This eliminates the
      // stale-runId / null-refreshed hazard and makes the InlineComplete
      // result available to callers.
      const completion = recordBarrierCompleteLocked(run.runId, phase.id, fileResult);
      if (completion && "type" in completion && completion.type === "complete") {
        return completion;
      }
      if (completion) {
        return stepInlineRunLocked(completion.runId);
      }
      return null;
    }
    return { type: "wait", runId: run.runId, phaseId: phase.id, pending: 1, completed: 0 };
  }

  run.startedPhaseIds.push(phase.id);
  persistRun(touchRun(run));
  updateRunRegistry(run);

  const resultPath = getRunResultPath(run.runId, run.agentId);
  const synthesizedPrompt = `${sanitizePromptField(phase.prompt) ?? ""}

Working directory: ${run.workingDirectory ?? "the current project directory"}
${phase.model ? `Use model: ${sanitizePromptField(phase.model) ?? ""}\n` : ""}Inputs from prior phases (read from the full .md reports where available):
${JSON.stringify(inputs, null, 2)}

When you are done, write your final synthesized report to ${resultPath}.

[FLOW_AGENT run_id=${run.runId} phase_id=${phase.id} agent_id=synthesize]`;

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

function completeRunLocked(run: RunState, result: string): InlineComplete & { error?: string } {
  run.status = "completed";
  run.currentPhaseId = null;
  // If a barrier agent was instructed to write result.md, prefer that file.
  const fileResult = readRunResult(run.runId, run.agentId);
  const finalResult = fileResult ?? result;
  persistRun(touchRun(run));
  updateRunRegistry(run);
  try {
    saveRunResult(run.runId, finalResult, run.agentId);
  } catch (err) {
    return {
      type: "complete",
      runId: run.runId,
      result: finalResult,
      resultPath: getRunResultDisplayPath(run.runId, run.agentId),
      error: String(err),
    };
  }
  return {
    type: "complete",
    runId: run.runId,
    result: finalResult,
    resultPath: getRunResultDisplayPath(run.runId, run.agentId),
  };
}
