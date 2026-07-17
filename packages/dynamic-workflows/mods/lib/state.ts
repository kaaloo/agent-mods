import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { serializeWorkflowMarkdown, loadWorkflowFromMarkdown } from "./markdown.ts";
import type { WorkflowDefinition } from "./schema.ts";

export const MOD_ID = "dynamic-workflows";

export function getLettaHome(): string {
  return process.env.LETTA_HOME ?? path.join(homedir(), ".letta");
}

export function getStateDir(): string {
  return path.join(getLettaHome(), "mods");
}

export function getStatePath(): string {
  return path.join(getStateDir(), `${MOD_ID}.state.json`);
}

export function getWorkflowsDir(): string {
  return path.join(getLettaHome(), "workflows");
}

export function getLibraryDir(): string {
  return path.join(getWorkflowsDir(), "library");
}

export function getRunsDir(): string {
  return path.join(getWorkflowsDir(), "runs");
}

export interface LibraryEntry {
  name: string;
  description: string;
  workflow: WorkflowDefinition;
  savedAt: string;
}

export type RunStatus = "running" | "completed" | "failed" | "paused";

export interface AgentRunState {
  phaseId: string;
  agentId: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed";
  output?: string;
  tokens?: number;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface RunState {
  runId: string;
  workflow: WorkflowDefinition;
  inputs: Record<string, string>;
  status: RunStatus;
  currentPhaseId: string | null;
  completedPhaseIds: string[];
  completedAgents: AgentRunState[];
  outputs: Record<string, string | Record<string, string>>;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export interface DynamicWorkflowsState {
  version: 1;
  runs: Record<string, { status: RunStatus; startedAt: string; updatedAt: string; currentPhaseId: string | null } >;
}

function emptyState(): DynamicWorkflowsState {
  return {
    version: 1,
    runs: {},
  };
}

export function readState(): DynamicWorkflowsState {
  try {
    const p = getStatePath();
    if (!existsSync(p)) return emptyState();
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      version: 1,
      runs: typeof parsed.runs === "object" && parsed.runs !== null ? parsed.runs : {},
    };
  } catch {
    return emptyState();
  }
}

export function writeState(state: DynamicWorkflowsState): void {
  const p = getStatePath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeJsonAtomically(p, state);
}

export function writeJsonAtomically(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    // On Windows cross-device rename can fail; fall back to overwrite.
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

export function writeTextFileAtomically(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.md`);
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, text, "utf8");
  }
}

export function readTextFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function getLibraryEntryPath(name: string): string {
  return path.join(getLibraryDir(), `${name}.md`);
}

export function saveLibraryEntry(entry: LibraryEntry): void {
  const filePath = getLibraryEntryPath(entry.name);
  const text = serializeWorkflowMarkdown(entry.workflow, `Saved at ${entry.savedAt}.`);
  writeTextFileAtomically(filePath, text);
}

export function loadLibraryEntry(name: string): LibraryEntry | null {
  const filePath = getLibraryEntryPath(name);
  const text = readTextFile(filePath);
  if (!text) return null;
  const { workflow, errors } = loadWorkflowFromMarkdown(text);
  if (!workflow || errors.length > 0) return null;
  const savedAt = workflow.name ? new Date().toISOString() : "";
  return {
    name,
    description: workflow.description,
    workflow,
    savedAt,
  };
}

export function listLibrary(): LibraryEntry[] {
  const dir = getLibraryDir();
  if (!existsSync(dir)) return [];
  const entries: LibraryEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".md") continue;
    const name = entry.name.replace(/\.md$/, "");
    const loaded = loadLibraryEntry(name);
    if (loaded) entries.push(loaded);
  }
  return entries;
}

export function deleteLibraryEntry(name: string): void {
  try {
    unlinkSync(getLibraryEntryPath(name));
  } catch { /* ignore */ }
}

export function generateRunId(): string {
  const now = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${now}-${random}`;
}

export function getRunDir(runId: string): string {
  return path.join(getRunsDir(), runId);
}

export function getRunPlanPath(runId: string): string {
  return path.join(getRunDir(runId), "plan.json");
}

export function getRunCheckpointPath(runId: string): string {
  return path.join(getRunDir(runId), "checkpoint.json");
}

export function getRunAgentPath(runId: string, phaseId: string, agentId: string): string {
  return path.join(getRunDir(runId), "phases", phaseId, `${agentId}.json`);
}

export function getRunAgentOutputPath(runId: string, phaseId: string, agentId: string): string {
  return path.join(getRunDir(runId), "phases", phaseId, `${agentId}.md`);
}

export function getRunResultPath(runId: string): string {
  return path.join(getRunDir(runId), "result.md");
}

export function readRunAgentOutput(runId: string, phaseId: string, agentId: string): string | null {
  return readTextFile(getRunAgentOutputPath(runId, phaseId, agentId));
}

export function readRunResult(runId: string): string | null {
  return readTextFile(getRunResultPath(runId));
}

export function createRun(workflow: WorkflowDefinition, inputs: Record<string, string> = {}): RunState {
  const runId = generateRunId();
  const firstPhase = workflow.phases[0] ?? null;
  const run: RunState = {
    runId,
    workflow,
    inputs,
    status: "running",
    currentPhaseId: firstPhase?.id ?? null,
    completedPhaseIds: [],
    completedAgents: [],
    outputs: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  persistRun(run);
  updateRunRegistry(run);
  return run;
}

export function persistRun(run: RunState): void {
  const runDir = getRunDir(run.runId);
  mkdirSync(runDir, { recursive: true });
  writeJsonAtomically(getRunPlanPath(run.runId), run.workflow);
  writeJsonAtomically(getRunCheckpointPath(run.runId), run);
}

export function loadRun(runId: string): RunState | null {
  const checkpoint = readTextFile(getRunCheckpointPath(runId));
  if (!checkpoint) return null;
  try {
    return JSON.parse(checkpoint) as RunState;
  } catch {
    return null;
  }
}

export function updateRunRegistry(run: RunState): void {
  const state = readState();
  state.runs[run.runId] = {
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    currentPhaseId: run.currentPhaseId,
  };
  writeState(state);
}

export function touchRun(run: RunState): RunState {
  run.updatedAt = new Date().toISOString();
  return run;
}

export function saveAgentResult(runId: string, phaseId: string, agentState: AgentRunState): void {
  const p = getRunAgentPath(runId, phaseId, agentState.agentId);
  mkdirSync(path.dirname(p), { recursive: true });
  writeJsonAtomically(p, agentState);
}

export function loadAgentResult(runId: string, phaseId: string, agentId: string): AgentRunState | null {
  const text = readTextFile(getRunAgentPath(runId, phaseId, agentId));
  if (!text) return null;
  try {
    return JSON.parse(text) as AgentRunState;
  } catch {
    return null;
  }
}

export function saveRunResult(runId: string, result: string): void {
  const p = getRunResultPath(runId);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, result, "utf8");
}

export function loadRunResult(runId: string): string | null {
  return readTextFile(getRunResultPath(runId));
}

