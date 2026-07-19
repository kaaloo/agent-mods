import { existsSync, mkdirSync, readFileSync, renameSync, readdirSync, writeFileSync, unlinkSync, rmSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { serializeWorkflowMarkdown, loadWorkflowFromMarkdown } from "./markdown.ts";
import { generateRunId, isSafeIdentifier, isSafePathComponent, isSafeRunId, isContainedPath } from "./utils.ts";
import type { WorkflowDefinition } from "./schema.ts";

// Per-run mutexes serialize all read-modify-write operations against a given
// run. Independent runs proceed concurrently; mutations within a single run
// are strictly ordered. The chain releases between awaits, so a function that
// awaits another mutexed helper does not deadlock on its own chain.
//
// The map is keyed by runId and entries are never removed; they hold only the
// tail of the promise chain, not the result, so memory cost is bounded by the
// number of distinct runIds ever observed. For long-lived processes this could
// grow; revisit if it becomes a concern.
const runMutexes = new Map<string, Promise<unknown>>();

export function withRunMutexFor<T>(runId: string, fn: () => Promise<T> | T): Promise<T> {
  if (!isSafeRunId(runId)) {
    // Defensive: reject unknown / unsafe runIds so a typo can't route work to
    // the shared "global" key by accident. Callers should validate upstream.
    return Promise.reject(new Error(`Refusing to take per-run mutex for unsafe runId: ${runId}`));
  }
  const previous = runMutexes.get(runId) ?? Promise.resolve();
  const next = previous.then(() => fn(), () => fn());
  // Swallow rejections on the tail so a single failed call does not poison
  // subsequent calls on the same run. Each caller still observes its own
  // rejection via the returned promise.
  runMutexes.set(runId, next.then(() => {}, () => {}));
  return next as Promise<T>;
}

export const MOD_ID = "flows";

export function getLettaHome(): string {
  const fallback = path.join(homedir(), ".letta");
  const raw = process.env.LETTA_HOME ?? fallback;
  // Normalize and require an absolute path. A relative LETTA_HOME would
  // resolve against the process cwd, which is attacker-controllable in
  // some harness setups. Closes M7 from bug-sweep 1784445631272-bdac05f1.
  const resolved = path.resolve(raw);
  return resolved;
}

let runtimeAgentId: string | undefined;

export function setRuntimeAgentId(id: string | undefined): void {
  if (id !== undefined && !isSafeIdentifier(id)) {
    // Reject values that would otherwise escape the agent dir; this closes
    // the inject Finding #1 (unvalidated agentId from env / readdir).
    return;
  }
  runtimeAgentId = id;
}

export function getAgentId(): string | undefined {
  if (runtimeAgentId) return runtimeAgentId;
  const env = process.env.LETTA_AGENT_ID ?? process.env.AGENT_ID;
  if (env && isSafeIdentifier(env)) return env;
  try {
    const agentsDir = path.join(getLettaHome(), "agents");
    if (!existsSync(agentsDir)) return undefined;
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    const agentDir = entries.find((e) => e.isDirectory() && e.name.startsWith("agent-") && isSafeIdentifier(e.name));
    return agentDir?.name;
  } catch {
    return undefined;
  }
}

// Resolve the agent ID under which a run's files should be read or written.
// Prefers the run's pinned value (captured at createRun time) so the path
// stays stable even if the runtime agent ID changes between events. Falls
// back to the runtime agent ID for runs created before pinning existed.
export function resolveRunAgentId(run: RunState | null | undefined): string | undefined {
  if (run?.agentId && isSafeIdentifier(run.agentId)) return run.agentId;
  return getAgentId();
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
  // The agent ID under which this run's files live. Captured at createRun
  // time so subsequent reads/writes resolve to a stable directory even if the
  // runtime agent ID flips between event handlers. Validated via
  // isSafeIdentifier; never read from disk without checking.
  agentId?: string;
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
    const rawRuns = data.runs;
    if (typeof rawRuns !== "object" || rawRuns === null || Array.isArray(rawRuns)) {
      return emptyState();
    }
    // Shape-validate each per-key entry. Drop any entry that is not a
    // non-null, non-array object — corrupted entries should not crash
    // downstream callers. Closes M4 from bug-sweep 1784445631272-bdac05f1.
    const cleanedRuns: DynamicWorkflowsState["runs"] = {};
    for (const [runId, entry] of Object.entries(rawRuns)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;
      cleanedRuns[runId] = {
        status: (typeof e.status === "string" ? e.status : "running") as DynamicWorkflowsState["runs"][string]["status"],
        startedAt: typeof e.startedAt === "string" ? e.startedAt : new Date().toISOString(),
        updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : new Date().toISOString(),
        currentPhaseId: typeof e.currentPhaseId === "string" || e.currentPhaseId === null ? e.currentPhaseId : null,
        conversationId: typeof e.conversationId === "string" ? e.conversationId : undefined,
      };
    }
    return { version: 1, runs: cleanedRuns };
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
  // Defense-in-depth: callers should validate before calling, but reject
  // unsafe names here so the path is never constructed with arbitrary
  // components. Closes M8 from bug-sweep 1784445631272-bdac05f1.
  if (!isSafeIdentifier(name)) {
    throw new Error(`Invalid library entry name "${name}".`);
  }
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

export function getRunDir(runId: string, runAgentId?: string): string {
  if (!isSafeRunId(runId)) {
    throw new Error(`Invalid run ID "${runId}".`);
  }
  // Validate any explicit runAgentId before letting it reach path.join.
  // path.join normalizes ".." segments, so an unvalidated value can escape
  // the agents directory and target arbitrary paths on disk.
  if (runAgentId !== undefined && !isSafeIdentifier(runAgentId)) {
    throw new Error(`Invalid run agent ID "${runAgentId}".`);
  }
  const baseDir = runAgentId
    ? path.join(getLettaHome(), "agents", runAgentId, "memory", MOD_ID, "runs")
    : getRunsDir();
  const target = path.join(baseDir, runId);
  // Containment check: the resolved target must live under the canonical runs
  // root for the chosen (or current) agent. This catches symlink escapes that
  // lexical `startsWith` would miss. We use realpathSync on the existing
  // parent when possible; otherwise fall back to lexical containment after
  // resolving the runs root. Note: lstat would not help here because the
  // target itself may not exist yet; the parent is what could be symlinked.
  const runsRoot = runAgentId
    ? path.join(getLettaHome(), "agents", runAgentId, "memory", MOD_ID, "runs")
    : getRunsDir();
  const resolvedRoot = path.resolve(runsRoot);
  const resolvedTarget = path.resolve(target);
  if (!isContainedPath(resolvedRoot, resolvedTarget)) {
    throw new Error(`Run path escapes runs directory: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

export function getRunPlanPath(runId: string, runAgentId?: string): string {
  return path.join(getRunDir(runId, runAgentId), "plan.md");
}

export function getRunPath(runId: string, runAgentId?: string): string {
  return path.join(getRunDir(runId, runAgentId), "run.md");
}

export function getRunAgentPath(runId: string, phaseId: string, agentId: string, runAgentId?: string): string {
  if (!isSafePathComponent(phaseId) || !isSafePathComponent(agentId)) {
    throw new Error(`Invalid phase or agent ID "${phaseId}" / "${agentId}".`);
  }
  return path.join(getRunDir(runId, runAgentId), "phases", phaseId, `${agentId}.md`);
}

export function getRunAgentOutputPath(runId: string, phaseId: string, agentId: string, runAgentId?: string): string {
  return getRunAgentPath(runId, phaseId, agentId, runAgentId);
}

export function getRunResultDisplayPath(runId: string, runAgentId?: string): string {
  const agentId = runAgentId ?? getAgentId();
  if (agentId) {
    return `~/.letta/agents/${agentId}/memory/${MOD_ID}/runs/${runId}/result.md`;
  }
  return `~/.letta/workflows/runs/${runId}/result.md`;
}

export function getRunResultPath(runId: string, runAgentId?: string): string {
  return path.join(getRunDir(runId, runAgentId), "result.md");
}

export function readRunAgentOutput(runId: string, phaseId: string, agentId: string, runAgentId?: string): string | null {
  const text = readTextFile(getRunAgentPath(runId, phaseId, agentId, runAgentId));
  if (!text) return null;
  const { body } = parseMarkdownFrontmatter(text);
  return body || null;
}

export function readRunResult(runId: string, runAgentId?: string): string | null {
  return readTextFile(getRunResultPath(runId, runAgentId));
}

export async function createRun(workflow: WorkflowDefinition, inputs: Record<string, string> = {}, conversationId?: string, workingDirectory?: string): Promise<RunState> {
  const runId = generateRunId();
  const firstPhase = workflow.phases[0] ?? null;
  // Pin the agent ID at creation so subsequent reads/writes resolve to a
  // stable directory even if the runtime agent ID flips between events.
  const currentAgentId = getAgentId();
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
    workingDirectory: sanitizeWorkingDirectory(workingDirectory),
    agentId: currentAgentId,
  };
  return withRunMutexFor(runId, () => {
    persistRun(run);
    updateRunRegistry(run);
    return run;
  });
}

// Strip control characters (including newlines) from a working-directory
// value before persisting or replaying it. Sub-agent prompts interpolate
// this value verbatim, so a control-character payload could split the
// instruction and inject additional directives. Closes H5 from the
// bug-sweep report (workingDirectory persisted verbatim and replayed into
// sub-agent instructions).
export function sanitizeWorkingDirectory(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  // Remove ASCII control characters (0x00-0x1F, 0x7F) and Unicode line/paragraph
  // separators. Keeps printable characters, spaces, and standard path punctuation.
  const cleaned = value.replace(/[\x00-\x1F\x7F\u2028\u2029]/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export function persistRun(run: RunState): void {
  const runDir = getRunDir(run.runId, run.agentId);
  mkdirSync(runDir, { recursive: true });
  writeTextFileAtomically(getRunPlanPath(run.runId, run.agentId), serializeWorkflowMarkdown(run.workflow));
  const runCopy: Record<string, unknown> = { ...run };
  delete runCopy.workflow;
  writeTextFileAtomically(getRunPath(run.runId, run.agentId), serializeMarkdownFrontmatter(runCopy));
}

export function touchRun(run: RunState): RunState {
  run.updatedAt = new Date().toISOString();
  return run;
}

export function loadRun(runId: string): RunState | null {
  if (!isSafeRunId(runId)) return null;
  // Try the current agent first; fall back to walking other agent dirs if
  // the run was created under a different agentId.
  const candidates = collectRunAgentCandidates();
  for (const agentId of candidates) {
    const loaded = tryLoadRunFromAgent(runId, agentId);
    if (loaded) return loaded;
  }
  return null;
}

function collectRunAgentCandidates(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const current = getAgentId();
  if (current) {
    seen.add(current);
    out.push(current);
  }
  try {
    const agentsDir = path.join(getLettaHome(), "agents");
    if (!existsSync(agentsDir)) return out;
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("agent-")) continue;
      if (!isSafeIdentifier(entry.name)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      out.push(entry.name);
    }
  } catch {
    // ignore — best-effort fallback
  }
  return out;
}

function tryLoadRunFromAgent(runId: string, runAgentId: string): RunState | null {
  try {
    const planPath = getRunPlanPath(runId, runAgentId);
    const runPath = getRunPath(runId, runAgentId);
    if (!existsSync(planPath) || !existsSync(runPath)) return null;
    const planText = readTextFile(planPath);
    if (!planText) return null;
    const { workflow, errors } = loadWorkflowFromMarkdown(planText);
    if (!workflow || errors.length > 0) return null;
    const runText = readTextFile(runPath);
    if (!runText) return null;
    const { data } = parseMarkdownFrontmatter(runText);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    // Reject the file if the persisted runId doesn't match the file path.
    // A tampered run.md could otherwise resurrect arbitrary identifiers.
    const persistedRunId = data.runId ? String(data.runId) : runId;
    if (persistedRunId !== runId) return null;
    // Do NOT trust data.agentId from disk. Pin to the validated runAgentId
    // argument that located the file; if the file claims a different id,
    // reject it so a tampered run.md cannot redirect subsequent writes.
    const persistedAgentId = data.agentId ? String(data.agentId) : undefined;
    if (persistedAgentId !== undefined && persistedAgentId !== runAgentId) {
      return null;
    }
    // Runtime-narrow each field instead of trusting `as` casts. Closes M5
    // from bug-sweep 1784445631272-bdac05f1.
    const status = (typeof data.status === "string" && (data.status === "running" || data.status === "completed" || data.status === "failed" || data.status === "paused"))
      ? (data.status as RunStatus)
      : "running";
    const inputs: Record<string, string> = (data.inputs && typeof data.inputs === "object" && !Array.isArray(data.inputs))
      ? Object.fromEntries(Object.entries(data.inputs as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][])
      : {};
    const outputs: Record<string, string | Record<string, string>> = (data.outputs && typeof data.outputs === "object" && !Array.isArray(data.outputs))
      ? (data.outputs as Record<string, string | Record<string, string>>)
      : {};
    return {
      runId: persistedRunId,
      workflow,
      inputs,
      status,
      currentPhaseId: typeof data.currentPhaseId === "string" || data.currentPhaseId === null ? data.currentPhaseId : null,
      completedPhaseIds: Array.isArray(data.completedPhaseIds)
        ? (data.completedPhaseIds as unknown[]).filter((v): v is string => typeof v === "string")
        : [],
      completedAgents: Array.isArray(data.completedAgents)
        ? (data.completedAgents as unknown[]).filter((v): v is AgentRunState => isAgentRunStateShape(v))
        : [],
      startedAgentIds: Array.isArray(data.startedAgentIds)
        ? (data.startedAgentIds as unknown[]).filter((v): v is string => typeof v === "string")
        : [],
      startedPhaseIds: Array.isArray(data.startedPhaseIds)
        ? (data.startedPhaseIds as unknown[]).filter((v): v is string => typeof v === "string")
        : [],
      outputs,
      startedAt: typeof data.startedAt === "string" ? data.startedAt : new Date().toISOString(),
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
      conversationId: typeof data.conversationId === "string" ? data.conversationId : undefined,
      workingDirectory: sanitizeWorkingDirectory(typeof data.workingDirectory === "string" ? data.workingDirectory : undefined),
      agentId: runAgentId,
      error: typeof data.error === "string" ? data.error : undefined,
    };
  } catch {
    return null;
  }
}

function isAgentRunStateShape(v: unknown): v is AgentRunState {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const a = v as Record<string, unknown>;
  return typeof a.phaseId === "string"
    && typeof a.agentId === "string"
    && typeof a.prompt === "string"
    && (a.status === "pending" || a.status === "running" || a.status === "completed" || a.status === "failed");
}

export function saveAgentResult(runId: string, phaseId: string, state: AgentRunState, runAgentId?: string): void {
  const filePath = getRunAgentPath(runId, phaseId, state.agentId, runAgentId);
  const output = state.output;
  const stateCopy: Record<string, unknown> = { ...state };
  delete stateCopy.output;
  writeTextFileAtomically(filePath, serializeMarkdownFrontmatter(stateCopy, output ?? ""));
}

export function loadAgentResult(runId: string, phaseId: string, agentId: string, runAgentId?: string): AgentRunState | null {
  try {
    const filePath = getRunAgentPath(runId, phaseId, agentId, runAgentId);
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

export function saveRunResult(runId: string, result: string, runAgentId?: string): void {
  writeTextFileAtomically(getRunResultPath(runId, runAgentId), result);
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

export function deleteRun(runId: string, runAgentId?: string): void {
  const target = getRunDir(runId, runAgentId);
  try {
    // Refuse to recursively delete if any part of the target path is a
    // symlink, even if the resolved path still appears to be under the runs
    // root. rmSync with force+recursive follows symlinks, so a planted link
    // could destroy arbitrary directories the process can reach.
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || stat.isDirectory() === false) return;
      // Also walk the immediate parent to catch symlinked ancestors. We only
      // need to check the directory entries above the target, which are
      // controlled by the agent/memory paths. If any of those are symlinks,
      // refuse to proceed.
      let cursor = target;
      const runsRoot = path.resolve(runAgentId
        ? path.join(getLettaHome(), "agents", runAgentId, "memory", MOD_ID, "runs")
        : getRunsDir());
      while (cursor !== runsRoot && cursor !== path.dirname(cursor)) {
        cursor = path.dirname(cursor);
        if (existsSync(cursor)) {
          const ls = lstatSync(cursor);
          if (ls.isSymbolicLink()) return;
        }
      }
    }
    rmSync(target, { recursive: true, force: true });
  } catch { /* ignore */ }
  const state = readState();
  delete state.runs[runId];
  writeState(state);
}
