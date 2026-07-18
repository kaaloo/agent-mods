import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { serializeWorkflowMarkdown, loadWorkflowFromMarkdown } from "./markdown.ts";
import { generateRunId, isSafeIdentifier, isSafePathComponent, isSafeRunId, isContainedPath } from "./utils.ts";
import type { WorkflowDefinition } from "./schema.ts";

let runMutex = Promise.resolve();

export function withRunMutex<T>(fn: () => Promise<T> | T): Promise<T> {
  const promise = runMutex.then(() => fn());
  runMutex = promise.then(() => {}, () => {});
  return promise;
}

export const MOD_ID = "flows";

export function getLettaHome(): string {
  return process.env.LETTA_HOME ?? path.join(homedir(), ".letta");
}

let runtimeAgentId: string | undefined;

export function setRuntimeAgentId(id: string | undefined): void {
  runtimeAgentId = id;
}

export function getAgentId(): string | undefined {
  if (runtimeAgentId) return runtimeAgentId;
  const env = process.env.LETTA_AGENT_ID ?? process.env.AGENT_ID;
  if (env) return env;
  try {
    const agentsDir = path.join(getLettaHome(), "agents");
    if (!existsSync(agentsDir)) return undefined;
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    const agentDir = entries.find((e) => e.isDirectory() && e.name.startsWith("agent-"));
    return agentDir?.name;
  } catch {
    return undefined;
  }
}

export function getWorkflowsDir(): string {
  const agentId = getAgentId();
  if (agentId) {
    return path.join(getLettaHome(), "agents", agentId, "memory", MOD_ID);
  }
  return path.join(getLettaHome(), "workflows");
}

export function getRegistryPath(): string {
  return path.join(getWorkflowsDir(), "registry.md");
}

export function getLibraryDir(): string {
  return path.join(getWorkflowsDir(), "library");
}

export function getTemplatesDir(): string {
  return path.join(getWorkflowsDir(), "templates");
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
  startedAgentIds: string[];
  startedPhaseIds: string[];
  outputs: Record<string, string | Record<string, string>>;
  startedAt: string;
  updatedAt: string;
  conversationId?: string;
  workingDirectory?: string;
  error?: string;
}

export interface DynamicWorkflowsState {
  version: 1;
  runs: Record<string, { status: RunStatus; startedAt: string; updatedAt: string; currentPhaseId: string | null; conversationId?: string }>;
}

function emptyState(): DynamicWorkflowsState {
  return {
    version: 1,
    runs: {},
  };
}

export function parseMarkdownFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const trimmed = text.trim();
  const match = trimmed.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: trimmed };
  try {
    const data = parse(match[1]) as Record<string, unknown>;
    return { data, body: match[2].trim() };
  } catch {
    return { data: {}, body: trimmed };
  }
}

export function serializeMarkdownFrontmatter(data: Record<string, unknown>, body = ""): string {
  const yaml = stringify(data, { lineWidth: 0, nullStr: "" }).trim();
  if (!body.trim()) return `---\n${yaml}\n---\n`;
  return `---\n${yaml}\n---\n\n${body.trim()}\n`;
}

export function readTextFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function writeTextFileAtomically(filePath: string, text: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${generateRunId().slice(-8)}.md`);
  writeFileSync(tmp, text, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, text, "utf8");
  }
}

export function writeJsonAtomically(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${generateRunId().slice(-8)}.json`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

export function readState(): DynamicWorkflowsState {
  try {
    const p = getRegistryPath();
    if (!existsSync(p)) return emptyState();
    const text = readTextFile(p);
    if (!text) return emptyState();
    const { data } = parseMarkdownFrontmatter(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return emptyState();
    return {
      version: 1,
      runs: typeof data.runs === "object" && data.runs !== null && !Array.isArray(data.runs) ? (data.runs as Record<string, unknown>) as DynamicWorkflowsState["runs"] : {},
    };
  } catch {
    return emptyState();
  }
}

export function writeState(state: DynamicWorkflowsState): void {
  const p = getRegistryPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeTextFileAtomically(p, serializeMarkdownFrontmatter({ version: 1, runs: state.runs }));
}

export function getLibraryEntryPath(name: string): string {
  return path.join(getLibraryDir(), `${name}.md`);
}

export function saveLibraryEntry(entry: LibraryEntry): void {
  if (!isSafeIdentifier(entry.name)) {
    throw new Error(`Invalid workflow name "${entry.name}".`);
  }
  const filePath = getLibraryEntryPath(entry.name);
  if (!isContainedPath(getLibraryDir(), filePath)) {
    throw new Error(`Workflow path escapes library directory: ${filePath}`);
  }
  const text = serializeWorkflowMarkdown(entry.workflow, `Saved at ${entry.savedAt}.`);
  writeTextFileAtomically(filePath, text);
}

export function loadLibraryEntry(name: string): LibraryEntry | null {
  if (!isSafeIdentifier(name)) return null;
  const filePath = getLibraryEntryPath(name);
  if (!isContainedPath(getLibraryDir(), filePath)) return null;
  const text = readTextFile(filePath);
  if (!text) return null;
  const { workflow, errors } = loadWorkflowFromMarkdown(text);
  if (!workflow || errors.length > 0) return null;
  return {
    name,
    description: workflow.description,
    workflow,
    savedAt: new Date().toISOString(),
  };
}

export function listLibrary(): LibraryEntry[] {
  const dir = getLibraryDir();
  if (!existsSync(dir)) return [];
  const entries: LibraryEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".md") continue;
    const name = entry.name.replace(/\.md$/, "");
    if (!isSafeIdentifier(name)) continue;
    const loaded = loadLibraryEntry(name);
    if (loaded) entries.push(loaded);
  }
  return entries;
}

export function deleteLibraryEntry(name: string): void {
  if (!isSafeIdentifier(name)) return;
  try {
    const filePath = getLibraryEntryPath(name);
    if (!isContainedPath(getLibraryDir(), filePath)) return;
    unlinkSync(filePath);
  } catch { /* ignore */ }
}

export function getRunDir(runId: string): string {
  if (!isSafeRunId(runId)) {
    throw new Error(`Invalid run ID "${runId}".`);
  }
  return path.join(getRunsDir(), runId);
}

export function getRunPlanPath(runId: string): string {
  return path.join(getRunDir(runId), "plan.md");
}

export function getRunPath(runId: string): string {
  return path.join(getRunDir(runId), "run.md");
}

export function getRunAgentPath(runId: string, phaseId: string, agentId: string): string {
  if (!isSafePathComponent(phaseId) || !isSafePathComponent(agentId)) {
    throw new Error(`Invalid phase or agent ID "${phaseId}" / "${agentId}".`);
  }
  return path.join(getRunDir(runId), "phases", phaseId, `${agentId}.md`);
}

export function getRunAgentOutputPath(runId: string, phaseId: string, agentId: string): string {
  return getRunAgentPath(runId, phaseId, agentId);
}

export function getRunResultDisplayPath(runId: string): string {
  const agentId = getAgentId();
  if (agentId) {
    return `~/.letta/agents/${agentId}/memory/${MOD_ID}/runs/${runId}/result.md`;
  }
  return `~/.letta/workflows/runs/${runId}/result.md`;
}

export function getRunResultPath(runId: string): string {
  return path.join(getRunDir(runId), "result.md");
}

export function readRunAgentOutput(runId: string, phaseId: string, agentId: string): string | null {
  const text = readTextFile(getRunAgentPath(runId, phaseId, agentId));
  if (!text) return null;
  const { body } = parseMarkdownFrontmatter(text);
  return body || null;
}

export function readRunResult(runId: string): string | null {
  return readTextFile(getRunResultPath(runId));
}

export async function createRun(workflow: WorkflowDefinition, inputs: Record<string, string> = {}, conversationId?: string, workingDirectory?: string): Promise<RunState> {
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
    startedAgentIds: [],
    startedPhaseIds: [],
    outputs: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    conversationId,
    workingDirectory,
  };
  return withRunMutex(() => {
    persistRun(run);
    updateRunRegistry(run);
    return run;
  });
}

export function persistRun(run: RunState): void {
  const runDir = getRunDir(run.runId);
  mkdirSync(runDir, { recursive: true });
  writeTextFileAtomically(getRunPlanPath(run.runId), serializeWorkflowMarkdown(run.workflow));
  const runCopy: Record<string, unknown> = { ...run };
  delete runCopy.workflow;
  writeTextFileAtomically(getRunPath(run.runId), serializeMarkdownFrontmatter(runCopy));
}

export function touchRun(run: RunState): RunState {
  run.updatedAt = new Date().toISOString();
  return run;
}

export function loadRun(runId: string): RunState | null {
  try {
    const planPath = getRunPlanPath(runId);
    const runPath = getRunPath(runId);
    if (!existsSync(planPath) || !existsSync(runPath)) return null;
    const planText = readTextFile(planPath);
    if (!planText) return null;
    const { workflow, errors } = loadWorkflowFromMarkdown(planText);
    if (!workflow || errors.length > 0) return null;
    const runText = readTextFile(runPath);
    if (!runText) return null;
    const { data } = parseMarkdownFrontmatter(runText);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return {
      runId: String(data.runId ?? runId),
      workflow,
      inputs: (data.inputs as Record<string, string>) ?? {},
      status: (data.status as RunStatus) ?? "running",
      currentPhaseId: (data.currentPhaseId as string | null) ?? null,
      completedPhaseIds: Array.isArray(data.completedPhaseIds) ? (data.completedPhaseIds as string[]) : [],
      completedAgents: Array.isArray(data.completedAgents) ? (data.completedAgents as AgentRunState[]) : [],
      startedAgentIds: Array.isArray(data.startedAgentIds) ? (data.startedAgentIds as string[]) : [],
      startedPhaseIds: Array.isArray(data.startedPhaseIds) ? (data.startedPhaseIds as string[]) : [],
      outputs: (data.outputs as Record<string, string | Record<string, string>>) ?? {},
      startedAt: String(data.startedAt ?? new Date().toISOString()),
      updatedAt: String(data.updatedAt ?? new Date().toISOString()),
      conversationId: data.conversationId ? String(data.conversationId) : undefined,
      workingDirectory: data.workingDirectory ? String(data.workingDirectory) : undefined,
      error: data.error ? String(data.error) : undefined,
    };
  } catch {
    return null;
  }
}

export function saveAgentResult(runId: string, phaseId: string, state: AgentRunState): void {
  const filePath = getRunAgentPath(runId, phaseId, state.agentId);
  const output = state.output;
  const stateCopy: Record<string, unknown> = { ...state };
  delete stateCopy.output;
  writeTextFileAtomically(filePath, serializeMarkdownFrontmatter(stateCopy, output ?? ""));
}

export function loadAgentResult(runId: string, phaseId: string, agentId: string): AgentRunState | null {
  try {
    const filePath = getRunAgentPath(runId, phaseId, agentId);
    if (!existsSync(filePath)) return null;
    const text = readTextFile(filePath);
    if (!text) return null;
    const { data, body } = parseMarkdownFrontmatter(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return {
      phaseId: String(data.phaseId ?? phaseId),
      agentId: String(data.agentId ?? agentId),
      prompt: String(data.prompt ?? ""),
      status: (data.status as AgentRunState["status"]) ?? "completed",
      output: body || undefined,
      tokens: typeof data.tokens === "number" ? data.tokens : undefined,
      durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
      startedAt: data.startedAt ? String(data.startedAt) : undefined,
      completedAt: data.completedAt ? String(data.completedAt) : undefined,
      error: data.error ? String(data.error) : undefined,
    };
  } catch {
    return null;
  }
}

export function saveRunResult(runId: string, result: string): void {
  writeTextFileAtomically(getRunResultPath(runId), result);
}

export function updateRunRegistry(run: RunState): void {
  const state = readState();
  state.runs[run.runId] = {
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    currentPhaseId: run.currentPhaseId,
    conversationId: run.conversationId,
  };
  writeState(state);
}

export function deleteRun(runId: string): void {
  try {
    rmSync(getRunDir(runId), { recursive: true, force: true });
  } catch { /* ignore */ }
  const state = readState();
  delete state.runs[runId];
  writeState(state);
}
