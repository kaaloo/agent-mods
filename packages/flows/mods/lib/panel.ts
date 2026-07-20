import type { RunState } from "./state.ts";
import { loadRun } from "./state.ts";
import { phaseById, isFanOutPhase } from "./schema.ts";
import { formatDuration } from "./utils.ts";

export function renderProgressPanel(runId: string | null, width = 100): string | string[] {
  if (!runId) return "";
  const run = loadRun(runId);
  if (!run) return "";

  const lines: string[] = [];
  const title = `workflows  [${run.workflow.name}]`;
  const elapsed = Date.now() - Date.parse(run.startedAt);
  const header = `${title}  ${run.status}  ${formatDuration(elapsed)}`;
  lines.push(header);

  for (const phase of run.workflow.phases) {
    const isCurrent = run.currentPhaseId === phase.id;
    const isCompleted = run.completedPhaseIds.includes(phase.id);
    const progress = renderPhaseProgress(phase, run, width - 4);
    const marker = isCompleted ? "✓" : isCurrent ? "▶" : " ";
    lines.push(`  ${marker} ${phase.id} (${phase.type}) ${progress}`);
  }

  return lines;
}

function renderPhaseProgress(phase: ReturnType<typeof phaseById>, run: RunState, width: number): string {
  if (!phase) return "";
  if (isFanOutPhase(phase)) {
    const completed = run.completedAgents.filter((a) => a.phaseId === phase.id).length;
    const total = phase.agents.length;
    return progressBar(completed, total, width);
  }
  const completed = run.completedPhaseIds.includes(phase.id);
  return completed ? "done" : "pending";
}

function progressBar(completed: number, total: number, width: number): string {
  if (total === 0) return "—";
  const ratio = completed / total;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const empty = Math.max(0, width - filled);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${completed}/${total}`;
}
