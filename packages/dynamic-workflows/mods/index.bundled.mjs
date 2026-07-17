// mods/index.ts
import path2 from "node:path";

// mods/lib/schema.ts
var WORKFLOW_VERSION = "1";
var DEFAULT_MAX_CONCURRENT = 4;
var MAX_WORKFLOW_NAME_LENGTH = 64;
function validateWorkflow(value) {
  const errors = [];
  if (!value || typeof value !== "object") {
    return { errors: [{ path: "", message: "Workflow must be an object." }] };
  }
  const obj = value;
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (!name) {
    errors.push({ path: "name", message: "Workflow name is required." });
  } else if (name.length > MAX_WORKFLOW_NAME_LENGTH) {
    errors.push({ path: "name", message: `Workflow name must be at most ${MAX_WORKFLOW_NAME_LENGTH} characters.` });
  }
  if (obj.version !== WORKFLOW_VERSION) {
    errors.push({ path: "version", message: `Workflow version must be "${WORKFLOW_VERSION}".` });
  }
  if (typeof obj.description !== "string" || !obj.description.trim()) {
    errors.push({ path: "description", message: "Workflow description is required." });
  }
  if (!Array.isArray(obj.phases) || obj.phases.length === 0) {
    errors.push({ path: "phases", message: "Workflow must have at least one phase." });
  } else {
    const phaseIds = new Set;
    for (let i = 0;i < obj.phases.length; i++) {
      const phase = obj.phases[i];
      if (!phase || typeof phase !== "object") {
        errors.push({ path: `phases[${i}]`, message: "Phase must be an object." });
        continue;
      }
      const p = phase;
      const id = typeof p.id === "string" ? p.id.trim() : "";
      if (!id) {
        errors.push({ path: `phases[${i}].id`, message: "Phase id is required." });
      } else if (phaseIds.has(id)) {
        errors.push({ path: `phases[${i}].id`, message: `Duplicate phase id "${id}".` });
      } else {
        phaseIds.add(id);
      }
      const type = typeof p.type === "string" ? p.type : "";
      if (type === "fan-out") {
        if (!Array.isArray(p.agents) || p.agents.length === 0) {
          errors.push({ path: `phases[${i}].agents`, message: "fan-out phase must have at least one agent." });
        } else {
          const agentIds = new Set;
          for (let j = 0;j < p.agents.length; j++) {
            const agent = p.agents[j];
            if (!agent || typeof agent !== "object") {
              errors.push({ path: `phases[${i}].agents[${j}]`, message: "Agent must be an object." });
              continue;
            }
            const a = agent;
            const agentId = typeof a.id === "string" ? a.id.trim() : "";
            if (!agentId) {
              errors.push({ path: `phases[${i}].agents[${j}].id`, message: "Agent id is required." });
            } else if (agentIds.has(agentId)) {
              errors.push({ path: `phases[${i}].agents[${j}].id`, message: `Duplicate agent id "${agentId}".` });
            } else {
              agentIds.add(agentId);
            }
            if (typeof a.prompt !== "string" || !a.prompt.trim()) {
              errors.push({ path: `phases[${i}].agents[${j}].prompt`, message: "Agent prompt is required." });
            }
          }
        }
      } else if (type === "barrier") {
        if (!Array.isArray(p.depends_on) || p.depends_on.length === 0) {
          errors.push({ path: `phases[${i}].depends_on`, message: "barrier phase must have at least one depends_on phase id." });
        } else {
          for (let k = 0;k < p.depends_on.length; k++) {
            if (typeof p.depends_on[k] !== "string" || !p.depends_on[k].trim()) {
              errors.push({ path: `phases[${i}].depends_on[${k}]`, message: "depends_on entry must be a non-empty string." });
            }
          }
        }
        if (typeof p.prompt !== "string" || !p.prompt.trim()) {
          errors.push({ path: `phases[${i}].prompt`, message: "barrier phase prompt is required." });
        }
      } else {
        errors.push({ path: `phases[${i}].type`, message: `Phase type must be "fan-out" or "barrier", got "${type}".` });
      }
    }
    if (phaseIds.size > 0) {
      for (let i = 0;i < obj.phases.length; i++) {
        const phase = obj.phases[i];
        if (phase.type === "barrier" && Array.isArray(phase.depends_on)) {
          for (const dep of phase.depends_on) {
            if (typeof dep === "string" && dep.trim() && !phaseIds.has(dep.trim())) {
              errors.push({ path: `phases[${i}].depends_on`, message: `Unknown phase id "${dep.trim()}".` });
            }
          }
        }
      }
    }
  }
  if (obj.budgets && typeof obj.budgets === "object") {
    const b = obj.budgets;
    if (b.max_tokens !== undefined && (typeof b.max_tokens !== "number" || !Number.isFinite(b.max_tokens) || b.max_tokens <= 0)) {
      errors.push({ path: "budgets.max_tokens", message: "max_tokens must be a positive number." });
    }
    if (b.max_concurrent !== undefined && (typeof b.max_concurrent !== "number" || !Number.isInteger(b.max_concurrent) || b.max_concurrent <= 0)) {
      errors.push({ path: "budgets.max_concurrent", message: "max_concurrent must be a positive integer." });
    }
    if (b.max_duration_ms !== undefined && (typeof b.max_duration_ms !== "number" || !Number.isFinite(b.max_duration_ms) || b.max_duration_ms <= 0)) {
      errors.push({ path: "budgets.max_duration_ms", message: "max_duration_ms must be a positive number." });
    }
  }
  if (errors.length > 0) {
    return { errors };
  }
  return { workflow: obj, errors: [] };
}
function isFanOutPhase(phase) {
  return phase.type === "fan-out";
}
function isBarrierPhase(phase) {
  return phase.type === "barrier";
}
function getPhaseMaxConcurrent(phase, workflowBudgets) {
  const workflowCap = workflowBudgets?.max_concurrent;
  if (isFanOutPhase(phase)) {
    const phaseCap = phase.concurrency;
    if (phaseCap && phaseCap > 0)
      return phaseCap;
  }
  if (workflowCap && workflowCap > 0)
    return workflowCap;
  return DEFAULT_MAX_CONCURRENT;
}
function phaseById(workflow, phaseId) {
  return workflow.phases.find((p) => p.id === phaseId);
}
function isPhaseComplete(workflow, phaseId, completedAgents) {
  const phase = phaseById(workflow, phaseId);
  if (!phase)
    return false;
  if (isFanOutPhase(phase)) {
    return phase.agents.every((a) => completedAgents.has(a.id));
  }
  if (isBarrierPhase(phase)) {
    return phase.depends_on.every((depId) => {
      const depPhase = phaseById(workflow, depId);
      if (!depPhase)
        return false;
      if (isFanOutPhase(depPhase)) {
        return depPhase.agents.every((a) => completedAgents.has(a.id));
      }
      return true;
    });
  }
  return false;
}
function nextPhase(workflow, completedPhaseIds) {
  for (const phase of workflow.phases) {
    if (completedPhaseIds.has(phase.id))
      continue;
    if (isBarrierPhase(phase)) {
      const depsComplete = phase.depends_on.every((id) => completedPhaseIds.has(id));
      if (!depsComplete)
        return;
    }
    return phase;
  }
  return;
}
function formatValidationErrors(errors) {
  return errors.map((e) => `${e.path}: ${e.message}`).join(`
`);
}

// mods/lib/author.ts
function buildAuthorPrompt(input) {
  const patternDescription = describePattern(input.pattern ?? "custom");
  return `You are a workflow architect. Design a JSON workflow definition for the following task.

Task: ${input.task}
${input.hints ? `Additional hints: ${input.hints}
` : ""}
Pattern guidance: ${patternDescription}

The workflow must conform to this JSON schema:

{
  "name": "kebab-case-workflow-name",
  "version": "1",
  "description": "One-line description.",
  "phases": [
    {
      "id": "scan",
      "type": "fan-out",
      "model": "optional-model-handle",
      "concurrency": 4,
      "agents": [
        { "id": "agent-1", "prompt": "Detailed prompt for this subagent." }
      ]
    },
    {
      "id": "synthesize",
      "type": "barrier",
      "depends_on": ["scan"],
      "model": "optional-model-handle",
      "prompt": "Prompt that references prior phase outputs."
    }
  ],
  "budgets": {
    "max_tokens": 500000,
    "max_concurrent": 4,
    "max_duration_ms": 3600000
  }
}

Rules:
- Use only "fan-out" and "barrier" phase types.
- Every fan-out phase must have at least one agent.
- Every barrier phase must have a non-empty "depends_on" array referencing earlier phase ids.
- Agent prompts should be self-contained and concrete.
- Model handles are optional; omit to use the default model.
- Keep the workflow small and debuggable for a first run.

After you generate the workflow, call workflow_save with the JSON object. Do not wrap the JSON in markdown code fences.`;
}
function authorWorkflow(input) {
  const prompt = buildAuthorPrompt(input);
  return { prompt };
}
function describePattern(pattern) {
  switch (pattern) {
    case "fan-out-barrier":
      return "Use a fan-out phase to run parallel subagents, then a barrier phase to synthesize their outputs into a single result.";
    case "research-verify":
      return "Use a fan-out phase to gather evidence from multiple angles, then a barrier phase to verify and cross-check.";
    case "audit":
      return "Use a fan-out phase to inspect different parts of the system, then a barrier phase to aggregate findings.";
    case "custom":
    default:
      return "Choose the simplest phase structure that fits the task. Prefer fan-out + barrier unless there is a clear reason for something else.";
  }
}

// mods/lib/state.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
var MOD_ID = "dynamic-workflows";
function getLettaHome() {
  return process.env.LETTA_HOME ?? path.join(homedir(), ".letta");
}
function getStateDir() {
  return path.join(getLettaHome(), "mods");
}
function getStatePath() {
  return path.join(getStateDir(), `${MOD_ID}.state.json`);
}
function getRunsDir() {
  return path.join(getLettaHome(), "workflows", "runs");
}
function emptyState() {
  return {
    version: 1,
    library: {},
    runs: {},
    ultracode: false
  };
}
function readState() {
  try {
    const p = getStatePath();
    if (!existsSync(p))
      return emptyState();
    const raw = readFileSync(p, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      return emptyState();
    return {
      version: 1,
      library: typeof parsed.library === "object" ? parsed.library : {},
      runs: typeof parsed.runs === "object" ? parsed.runs : {},
      ultracode: Boolean(parsed.ultracode)
    };
  } catch {
    return emptyState();
  }
}
function writeState(state) {
  const p = getStatePath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeJsonAtomically(p, state);
}
function writeJsonAtomically(filePath, value) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}.json`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}
`, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch {
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}
`, "utf8");
  }
}
function readTextFile(filePath) {
  try {
    if (!existsSync(filePath))
      return null;
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}
function saveLibraryEntry(entry) {
  const state = readState();
  state.library[entry.name] = entry;
  writeState(state);
}
function loadLibraryEntry(name) {
  return readState().library[name] ?? null;
}
function listLibrary() {
  return Object.values(readState().library);
}
function generateRunId() {
  const now = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${now}-${random}`;
}
function getRunDir(runId) {
  return path.join(getRunsDir(), runId);
}
function getRunPlanPath(runId) {
  return path.join(getRunDir(runId), "plan.json");
}
function getRunCheckpointPath(runId) {
  return path.join(getRunDir(runId), "checkpoint.json");
}
function getRunAgentPath(runId, phaseId, agentId) {
  return path.join(getRunDir(runId), "phases", phaseId, `${agentId}.json`);
}
function getRunResultPath(runId) {
  return path.join(getRunDir(runId), "result.md");
}
function createRun(workflow, inputs = {}) {
  const runId = generateRunId();
  const firstPhase = workflow.phases[0] ?? null;
  const run = {
    runId,
    workflow,
    inputs,
    status: "running",
    currentPhaseId: firstPhase?.id ?? null,
    completedPhaseIds: [],
    completedAgents: [],
    outputs: {},
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  persistRun(run);
  updateRunRegistry(run);
  return run;
}
function persistRun(run) {
  const runDir = getRunDir(run.runId);
  mkdirSync(runDir, { recursive: true });
  writeJsonAtomically(getRunPlanPath(run.runId), run.workflow);
  writeJsonAtomically(getRunCheckpointPath(run.runId), run);
}
function loadRun(runId) {
  const checkpoint = readTextFile(getRunCheckpointPath(runId));
  if (!checkpoint)
    return null;
  try {
    return JSON.parse(checkpoint);
  } catch {
    return null;
  }
}
function updateRunRegistry(run) {
  const state = readState();
  state.runs[run.runId] = {
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    currentPhaseId: run.currentPhaseId
  };
  writeState(state);
}
function touchRun(run) {
  run.updatedAt = new Date().toISOString();
  return run;
}
function saveAgentResult(runId, phaseId, agentState) {
  const p = getRunAgentPath(runId, phaseId, agentState.agentId);
  mkdirSync(path.dirname(p), { recursive: true });
  writeJsonAtomically(p, agentState);
}
function loadAgentResult(runId, phaseId, agentId) {
  const text = readTextFile(getRunAgentPath(runId, phaseId, agentId));
  if (!text)
    return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function saveRunResult(runId, result) {
  const p = getRunResultPath(runId);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, result, "utf8");
}
function loadRunResult(runId) {
  return readTextFile(getRunResultPath(runId));
}
function setUltracode(enabled) {
  const state = readState();
  state.ultracode = enabled;
  writeState(state);
  return state.ultracode;
}

// mods/lib/utils.ts
function formatDuration(ms) {
  if (ms === undefined)
    return "—";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60)
    return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// mods/lib/panel.ts
function renderProgressPanel(runId, width = 100) {
  if (!runId)
    return "";
  const run = loadRun(runId);
  if (!run)
    return "";
  const lines = [];
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
function renderPhaseProgress(phase, run, width) {
  if (!phase)
    return "";
  if (isFanOutPhase(phase)) {
    const completed2 = run.completedAgents.filter((a) => a.phaseId === phase.id).length;
    const total = phase.agents.length;
    return progressBar(completed2, total, width);
  }
  const completed = run.completedPhaseIds.includes(phase.id);
  return completed ? "done" : "pending";
}
function progressBar(completed, total, width) {
  if (total === 0)
    return "—";
  const ratio = completed / total;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const empty = Math.max(0, width - filled);
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${completed}/${total}`;
}

// mods/lib/runner-inline.ts
function stepInlineRun(runId) {
  const run = loadRun(runId);
  if (!run)
    return null;
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
function recordAgentComplete(runId, phaseId, agentId, output) {
  const run = loadRun(runId);
  if (!run)
    return null;
  const phase = phaseById(run.workflow, phaseId);
  if (!phase || !isFanOutPhase(phase))
    return null;
  const agent = phase.agents.find((a) => a.id === agentId);
  if (!agent)
    return null;
  const existing = loadAgentResult(runId, phaseId, agentId);
  const state = existing ? { ...existing, status: "completed", output, completedAt: new Date().toISOString() } : {
    phaseId,
    agentId,
    prompt: agent.prompt,
    status: "completed",
    output,
    completedAt: new Date().toISOString()
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
function recordBarrierComplete(runId, phaseId, output) {
  const run = loadRun(runId);
  if (!run)
    return null;
  const phase = phaseById(run.workflow, phaseId);
  if (!phase || !isBarrierPhase(phase))
    return null;
  run.outputs[phaseId] = output;
  advancePhase(run);
  persistRun(touchRun(run));
  updateRunRegistry(run);
  return run;
}
function dispatchFanOut(run, phase) {
  const completedIds = new Set(run.completedAgents.map((a) => a.agentId));
  const pendingAgents = phase.agents.filter((a) => !completedIds.has(a.id));
  if (pendingAgents.length === 0) {
    advancePhase(run);
    persistRun(touchRun(run));
    updateRunRegistry(run);
    return stepInlineRun(run.runId);
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
    agents: dispatchNow.map((a) => ({ id: a.id, prompt: a.prompt, model: phase.model }))
  };
}
function dispatchBarrier(run, phase) {
  const inputs = phase.depends_on.map((depId) => {
    const dep = phaseById(run.workflow, depId);
    if (!dep)
      return { phaseId: depId, outputs: {} };
    if (isFanOutPhase(dep)) {
      const outputs = {};
      for (const agent of dep.agents) {
        const key = `${depId}.${agent.id}`;
        if (run.outputs[key])
          outputs[agent.id] = String(run.outputs[key]);
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
    agents: [{ id: "synthesize", prompt: synthesizedPrompt, model: phase.model }]
  };
}
function advancePhase(run) {
  const completedIds = new Set(run.completedPhaseIds);
  if (run.currentPhaseId)
    completedIds.add(run.currentPhaseId);
  run.completedPhaseIds = Array.from(completedIds);
  const next = nextPhase(run.workflow, completedIds);
  if (next) {
    run.currentPhaseId = next.id;
  } else {
    run.currentPhaseId = null;
    run.status = "completed";
  }
}
function completeRun(run, result) {
  run.status = "completed";
  run.currentPhaseId = null;
  persistRun(touchRun(run));
  updateRunRegistry(run);
  saveRunResult(run.runId, result);
  return {
    type: "complete",
    runId: run.runId,
    result,
    resultPath: `~/.letta/workflows/runs/${run.runId}/result.md`
  };
}

// mods/lib/templates.ts
import { readdirSync, readFileSync as readFileSync2 } from "node:fs";
import { extname } from "node:path";
function listTemplates(templateDir) {
  try {
    const entries = readdirSync(templateDir, { withFileTypes: true });
    const templates = [];
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== ".json")
        continue;
      const filename = entry.name;
      const text = readFileSync2(`${templateDir}/${filename}`, "utf8");
      try {
        const parsed = JSON.parse(text);
        const { workflow, errors } = validateWorkflow(parsed);
        if (workflow && errors.length === 0) {
          templates.push({
            name: filename.replace(/\.json$/, ""),
            description: workflow.description,
            source: "template"
          });
        }
      } catch {}
    }
    return templates;
  } catch {
    return [];
  }
}
function loadTemplate(templateDir, name) {
  const filename = `${name}.json`;
  const text = readFileSync2(`${templateDir}/${filename}`, "utf8");
  const parsed = JSON.parse(text);
  const { workflow } = validateWorkflow(parsed);
  return workflow;
}

// mods/index.ts
var PANEL_ID = "dynamic-workflows";
function activate(letta) {
  const disposers = [];
  let activeRunId = null;
  let panel = null;
  const TEMPLATE_DIR = path2.resolve(import.meta.dirname, "../assets/templates");
  function refreshPanel() {
    if (panel) {
      try {
        panel.update();
      } catch {}
    }
  }
  function safeOn(event, handler) {
    try {
      disposers.push(letta.events.on(event, handler));
    } catch {}
  }
  if (letta.capabilities?.ui?.panels && letta.ui) {
    try {
      panel = letta.ui.openPanel({
        id: PANEL_ID,
        order: 100,
        render: () => renderProgressPanel(activeRunId) ?? "No active workflow."
      });
      disposers.push(() => {
        try {
          panel?.close();
        } catch {}
      });
    } catch {}
  }
  if (letta.capabilities?.tools) {
    disposers.push(letta.tools.register({
      name: "workflow_author",
      description: "Generate a workflow prompt for the model to author a JSON workflow definition for a given task.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "High-level task description." },
          pattern: { type: "string", enum: ["fan-out-barrier", "research-verify", "audit", "custom"], description: "Optional pattern hint." },
          hints: { type: "string", description: "Optional additional hints." }
        },
        required: ["task"]
      },
      approvalPolicy: "auto",
      parallelSafe: true,
      run(ctx) {
        const { task, pattern, hints } = ctx.args || {};
        if (!isNonEmptyString(task)) {
          return { status: "error", content: "task is required" };
        }
        const { prompt } = authorWorkflow({ task, pattern, hints });
        return { status: "success", content: prompt };
      }
    }));
    disposers.push(letta.tools.register({
      name: "workflow_save",
      description: "Save a workflow definition to the local library. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique kebab-case workflow name." },
          workflow: { type: "object", description: "Workflow definition object." },
          description: { type: "string", description: "Optional description override." }
        },
        required: ["name", "workflow"]
      },
      approvalPolicy: "alwaysAsk",
      parallelSafe: false,
      run(ctx) {
        const { name, workflow, description } = ctx.args || {};
        if (!isNonEmptyString(name)) {
          return { status: "error", content: "name is required" };
        }
        const { workflow: validated, errors } = validateWorkflow(workflow);
        if (errors.length > 0) {
          return { status: "error", content: formatValidationErrors(errors) };
        }
        if (!validated) {
          return { status: "error", content: "Validation failed" };
        }
        saveLibraryEntry({
          name,
          description: isNonEmptyString(description) ? description : validated.description,
          workflow: validated,
          savedAt: new Date().toISOString()
        });
        return { status: "success", content: `Saved workflow "${name}".` };
      }
    }));
    disposers.push(letta.tools.register({
      name: "workflow_load",
      description: "Load a saved workflow definition by name. Falls back to bundled templates.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      },
      approvalPolicy: "auto",
      parallelSafe: true,
      run(ctx) {
        const { name } = ctx.args || {};
        if (!isNonEmptyString(name)) {
          return { status: "error", content: "name is required" };
        }
        const entry = loadLibraryEntry(name);
        if (entry) {
          return { status: "success", workflow: entry.workflow, source: "library" };
        }
        const template = loadTemplate(TEMPLATE_DIR, name);
        if (template) {
          return { status: "success", workflow: template, source: "template" };
        }
        return { status: "error", content: `Workflow "${name}" not found.` };
      }
    }));
    disposers.push(letta.tools.register({
      name: "workflow_list",
      description: "List saved workflows and bundled example templates.",
      parameters: {
        type: "object",
        properties: { filter: { type: "string", description: "Optional name filter substring." } }
      },
      approvalPolicy: "auto",
      parallelSafe: true,
      run(ctx) {
        const { filter } = ctx.args || {};
        const entries = listLibrary();
        const templates = listTemplates(TEMPLATE_DIR);
        const all = [
          ...entries.map((e) => ({ name: e.name, description: e.description, source: "library", savedAt: e.savedAt })),
          ...templates.map((t) => ({ name: t.name, description: t.description, source: t.source, savedAt: undefined }))
        ];
        const filtered = all.filter((e) => !filter || e.name.toLowerCase().includes(String(filter).toLowerCase()) || e.description.toLowerCase().includes(String(filter).toLowerCase()));
        return { status: "success", workflows: filtered };
      }
    }));
    disposers.push(letta.tools.register({
      name: "workflow_run",
      description: "Start an inline run of a workflow. Returns a run ID and dispatch instructions for the current phase. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Workflow name." },
          inputs: { type: "object", description: "Optional key-value inputs." }
        },
        required: ["name"]
      },
      approvalPolicy: "alwaysAsk",
      parallelSafe: false,
      run(ctx) {
        const { name, inputs } = ctx.args || {};
        if (!isNonEmptyString(name)) {
          return { status: "error", content: "name is required" };
        }
        const entry = loadLibraryEntry(name);
        const workflow = entry?.workflow ?? loadTemplate(TEMPLATE_DIR, name);
        if (!workflow) {
          return { status: "error", content: `Workflow "${name}" not found.` };
        }
        const run = createRun(workflow, normalizeInputs(inputs));
        activeRunId = run.runId;
        updateRunRegistry(run);
        refreshPanel();
        const step = stepInlineRun(run.runId);
        return { status: "success", runId: run.runId, step };
      }
    }));
    disposers.push(letta.tools.register({
      name: "workflow_status",
      description: "Query the current state of a run.",
      parameters: {
        type: "object",
        properties: { run_id: { type: "string" } },
        required: ["run_id"]
      },
      approvalPolicy: "auto",
      parallelSafe: true,
      run(ctx) {
        const { run_id } = ctx.args || {};
        if (!isNonEmptyString(run_id)) {
          return { status: "error", content: "run_id is required" };
        }
        const run = loadRun(run_id);
        if (!run) {
          return { status: "error", content: `Run "${run_id}" not found.` };
        }
        const step = stepInlineRun(run_id);
        return { status: "success", run, step };
      }
    }));
    disposers.push(letta.tools.register({
      name: "workflow_set_ultracode",
      description: "Toggle ultracode mode (v0.2: propose workflows on turn start).",
      parameters: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"]
      },
      approvalPolicy: "auto",
      parallelSafe: false,
      run(ctx) {
        const enabled = ctx.args?.enabled;
        return { status: "success", ultracode: setUltracode(Boolean(enabled)) };
      }
    }));
  }
  if (letta.capabilities?.commands) {
    disposers.push(letta.commands.register({
      id: "workflow",
      description: "Show or refresh the Dynamic Workflows progress panel.",
      run: () => {
        refreshPanel();
        return { type: "output", output: activeRunId ? `Workflow panel active. Run ID: ${activeRunId}` : "No active workflow." };
      }
    }));
    disposers.push(letta.commands.register({
      id: "workflow-author",
      description: "Author a new workflow for the given task.",
      args: "<task>",
      run: (ctx) => {
        const args = normalizeCommandArgs(ctx.args);
        if (!args) {
          return { type: "output", output: "Usage: /workflow-author <task>" };
        }
        const { prompt } = authorWorkflow({ task: args });
        return { type: "output", output: prompt };
      }
    }));
    disposers.push(letta.commands.register({
      id: "workflow-save",
      description: "Save the most recently authored workflow to the library.",
      args: "<name>",
      run: (ctx) => {
        const name = normalizeCommandArgs(ctx.args);
        if (!name) {
          return { type: "output", output: "Usage: /workflow-save <name>" };
        }
        return { type: "output", output: `To save a workflow, call the workflow_save tool with name="${name}" and the workflow JSON.` };
      }
    }));
    disposers.push(letta.commands.register({
      id: "workflow-list",
      description: "List saved workflows and bundled templates.",
      run: () => {
        const entries = listLibrary();
        const templates = listTemplates(TEMPLATE_DIR);
        const lines = [
          "Saved workflows:",
          ...entries.map((e) => `  • ${e.name} — ${e.description}`),
          "Bundled templates:",
          ...templates.map((t) => `  • ${t.name} — ${t.description}`)
        ];
        return { type: "output", output: lines.join(`
`) };
      }
    }));
    disposers.push(letta.commands.register({
      id: "workflow-run",
      description: "Run a saved workflow inline.",
      args: "<name>",
      runWhenBusy: true,
      run: (ctx) => {
        const name = normalizeCommandArgs(ctx.args);
        if (!name) {
          return { type: "output", output: "Usage: /workflow-run <name>" };
        }
        const entry = loadLibraryEntry(name);
        const workflow = entry?.workflow ?? loadTemplate(TEMPLATE_DIR, name);
        if (!workflow) {
          return { type: "output", output: `Workflow "${name}" not found.` };
        }
        const run = createRun(workflow);
        activeRunId = run.runId;
        updateRunRegistry(run);
        refreshPanel();
        const step = stepInlineRun(run.runId);
        return { type: "output", output: formatStep(step) };
      }
    }));
    disposers.push(letta.commands.register({
      id: "ultracode",
      description: "Toggle ultracode mode.",
      args: "on|off",
      run: (ctx) => {
        const arg = normalizeCommandArgs(ctx.args);
        const value = arg === "on" || arg === "true" || arg === "enabled";
        setUltracode(value);
        return { type: "output", output: `Ultracode ${value ? "enabled" : "disabled"}.` };
      }
    }));
  }
  if (letta.capabilities?.events?.tools) {
    safeOn("tool_end", (event) => {
      if (!activeRunId || !event || typeof event !== "object")
        return;
      const toolName = event.toolName;
      const result = event.result;
      if (typeof toolName !== "string" || toolName !== "Agent")
        return;
      const args = event.args ?? event.arguments;
      if (!args || typeof args !== "object")
        return;
      const runId = args.run_id ?? args.runId;
      const phaseId = args.phase_id ?? args.phaseId;
      const agentId = args.agent_id ?? args.agentId;
      if (!isNonEmptyString(runId) || !isNonEmptyString(phaseId) || !isNonEmptyString(agentId))
        return;
      if (runId !== activeRunId)
        return;
      const run = loadRun(runId);
      if (!run)
        return;
      const phase = run.workflow.phases.find((p) => p.id === phaseId);
      if (!phase)
        return;
      const output = typeof result === "string" ? result : JSON.stringify(result);
      if (isFanOutPhase(phase)) {
        recordAgentComplete(runId, phaseId, agentId, output);
      } else if (isBarrierPhase(phase)) {
        recordBarrierComplete(runId, phaseId, output);
      }
      refreshPanel();
    });
  }
  if (letta.capabilities?.events?.lifecycle) {
    safeOn("conversation_open", () => {
      const state = readState();
      const running = Object.entries(state.runs).find(([, r]) => r.status === "running");
      if (running) {
        activeRunId = running[0];
        refreshPanel();
      }
    });
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {}
    }
  };
}
function normalizeCommandArgs(value) {
  if (value === undefined || value === null)
    return null;
  if (typeof value === "string")
    return value.trim();
  if (typeof value === "object") {
    const text = value.text ?? value.query ?? value.name ?? value.args;
    if (typeof text === "string")
      return text.trim();
  }
  return null;
}
function normalizeInputs(value) {
  if (!value || typeof value !== "object")
    return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined && v !== null) {
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }
  return out;
}
function formatStep(step) {
  if (!step)
    return "No step available.";
  if (step.type === "complete")
    return `Workflow complete. Result: ${step.resultPath}`;
  if (step.type === "dispatch")
    return `${step.instructions}

Agents:
${step.agents?.map((a) => `  - ${a.id}: ${a.prompt.slice(0, 120)}...`).join(`
`) ?? ""}`;
  if (step.type === "wait")
    return `Waiting for phase "${step.phaseId}" (${step.completed}/${step.completed + step.pending} complete).`;
  return "Unknown step.";
}
export {
  activate as default
};
