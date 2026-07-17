import path from "node:path";
import type { LettaModContext, LettaToolContext, LettaCommandContext, LettaEvent, LettaEventHandlerContext } from "./types.ts";
import { authorWorkflow } from "./lib/author.ts";
import { validateWorkflow, formatValidationErrors, isFanOutPhase, isBarrierPhase } from "./lib/schema.ts";
import { renderProgressPanel } from "./lib/panel.ts";
import {
  createRun,
  loadRun,
  readState,
  loadLibraryEntry,
  saveLibraryEntry,
  listLibrary,
  updateRunRegistry,
  setUltracode,
} from "./lib/state.ts";
import { stepInlineRun, recordAgentComplete, recordBarrierComplete } from "./lib/runner-inline.ts";
import { listTemplates, loadTemplate } from "./lib/templates.ts";
import { isNonEmptyString } from "./lib/utils.ts";

const PANEL_ID = "dynamic-workflows";

export default function activate(letta: LettaModContext): (() => void) {
  const disposers: Array<() => void> = [];
  let activeRunId: string | null = null;
  let panel: { update: () => void; close: () => void } | null = null;

  const TEMPLATE_DIR = path.resolve(import.meta.dirname, "../assets/templates");

  function refreshPanel(): void {
    if (panel) {
      try { panel.update(); } catch { /* ignore */ }
    }
  }

  function safeOn(event: string, handler: (event: LettaEvent, ctx: LettaEventHandlerContext) => void): void {
    try { disposers.push(letta.events.on(event, handler)); } catch { /* ignore */ }
  }

  // ── Panel ──
  if (letta.capabilities?.ui?.panels && letta.ui) {
    try {
      panel = letta.ui.openPanel({
        id: PANEL_ID,
        order: 100,
        render: () => renderProgressPanel(activeRunId) ?? "No active workflow.",
      });
      disposers.push(() => { try { panel?.close(); } catch {} });
    } catch { /* ignore */ }
  }

  // ── Tools ──
  if (letta.capabilities?.tools) {
    disposers.push(letta.tools.register({
      name: "workflow_author",
      description: "Generate a workflow prompt for the model to author a JSON workflow definition for a given task.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "High-level task description." },
          pattern: { type: "string", enum: ["fan-out-barrier", "research-verify", "audit", "custom"], description: "Optional pattern hint." },
          hints: { type: "string", description: "Optional additional hints." },
        },
        required: ["task"],
      },
      approvalPolicy: "auto",
      parallelSafe: true,
      run(ctx: LettaToolContext) {
        const { task, pattern, hints } = ctx.args || {};
        if (!isNonEmptyString(task)) {
          return { status: "error", content: "task is required" };
        }
        const { prompt } = authorWorkflow({ task, pattern: pattern as any, hints: hints as string | undefined });
        return { status: "success", content: prompt };
      },
    }));

    disposers.push(letta.tools.register({
      name: "workflow_save",
      description: "Save a workflow definition to the local library. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique kebab-case workflow name." },
          workflow: { type: "object", description: "Workflow definition object." },
          description: { type: "string", description: "Optional description override." },
        },
        required: ["name", "workflow"],
      },
      approvalPolicy: "alwaysAsk",
      parallelSafe: false,
      run(ctx: LettaToolContext) {
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
          savedAt: new Date().toISOString(),
        });
        return { status: "success", content: `Saved workflow "${name}".` };
      },
    }));

    disposers.push(letta.tools.register({
      name: "workflow_load",
      description: "Load a saved workflow definition by name. Falls back to bundled templates.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      approvalPolicy: "auto",
      parallelSafe: true,
      run(ctx: LettaToolContext) {
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
      },
    }));

    disposers.push(letta.tools.register({
      name: "workflow_list",
      description: "List saved workflows and bundled example templates.",
      parameters: {
        type: "object",
        properties: { filter: { type: "string", description: "Optional name filter substring." } },
      },
      approvalPolicy: "auto",
      parallelSafe: true,
      run(ctx: LettaToolContext) {
        const { filter } = ctx.args || {};
        const entries = listLibrary();
        const templates = listTemplates(TEMPLATE_DIR);
        const all = [
          ...entries.map((e) => ({ name: e.name, description: e.description, source: "library" as const, savedAt: e.savedAt })),
          ...templates.map((t) => ({ name: t.name, description: t.description, source: t.source, savedAt: undefined })),
        ];
        const filtered = all.filter((e) =>
          !filter ||
          e.name.toLowerCase().includes(String(filter).toLowerCase()) ||
          e.description.toLowerCase().includes(String(filter).toLowerCase())
        );
        return { status: "success", workflows: filtered };
      },
    }));

    disposers.push(letta.tools.register({
      name: "workflow_run",
      description: "Start an inline run of a workflow. Returns a run ID and dispatch instructions for the current phase. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Workflow name." },
          inputs: { type: "object", description: "Optional key-value inputs." },
        },
        required: ["name"],
      },
      approvalPolicy: "alwaysAsk",
      parallelSafe: false,
      run(ctx: LettaToolContext) {
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
      },
    }));

    disposers.push(letta.tools.register({
      name: "workflow_status",
      description: "Query the current state of a run.",
      parameters: {
        type: "object",
        properties: { run_id: { type: "string" } },
        required: ["run_id"],
      },
      approvalPolicy: "auto",
      parallelSafe: true,
      run(ctx: LettaToolContext) {
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
      },
    }));

    disposers.push(letta.tools.register({
      name: "workflow_set_ultracode",
      description: "Toggle ultracode mode (v0.2: propose workflows on turn start).",
      parameters: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
      },
      approvalPolicy: "auto",
      parallelSafe: false,
      run(ctx: LettaToolContext) {
        const enabled = ctx.args?.enabled;
        return { status: "success", ultracode: setUltracode(Boolean(enabled)) };
      },
    }));
  }

  // ── Commands ──
  if (letta.capabilities?.commands) {
    disposers.push(letta.commands.register({
      id: "workflow",
      description: "Show or refresh the Dynamic Workflows progress panel.",
      run: () => {
        refreshPanel();
        return { type: "output", output: activeRunId ? `Workflow panel active. Run ID: ${activeRunId}` : "No active workflow." };
      },
    }));

    disposers.push(letta.commands.register({
      id: "workflow-author",
      description: "Author a new workflow for the given task.",
      args: "<task>",
      run: (ctx: LettaCommandContext) => {
        const args = normalizeCommandArgs(ctx.args);
        if (!args) {
          return { type: "output", output: "Usage: /workflow-author <task>" };
        }
        const { prompt } = authorWorkflow({ task: args });
        return { type: "output", output: prompt };
      },
    }));

    disposers.push(letta.commands.register({
      id: "workflow-save",
      description: "Save the most recently authored workflow to the library.",
      args: "<name>",
      run: (ctx: LettaCommandContext) => {
        const name = normalizeCommandArgs(ctx.args);
        if (!name) {
          return { type: "output", output: "Usage: /workflow-save <name>" };
        }
        return { type: "output", output: `To save a workflow, call the workflow_save tool with name="${name}" and the workflow JSON.` };
      },
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
          ...templates.map((t) => `  • ${t.name} — ${t.description}`),
        ];
        return { type: "output", output: lines.join("\n") };
      },
    }));

    disposers.push(letta.commands.register({
      id: "workflow-run",
      description: "Run a saved workflow inline.",
      args: "<name>",
      runWhenBusy: true,
      run: (ctx: LettaCommandContext) => {
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
      },
    }));

    disposers.push(letta.commands.register({
      id: "ultracode",
      description: "Toggle ultracode mode.",
      args: "on|off",
      run: (ctx: LettaCommandContext) => {
        const arg = normalizeCommandArgs(ctx.args);
        const value = arg === "on" || arg === "true" || arg === "enabled";
        setUltracode(value);
        return { type: "output", output: `Ultracode ${value ? "enabled" : "disabled"}.` };
      },
    }));
  }

  // ── Events ──
  if (letta.capabilities?.events?.tools) {
    safeOn("tool_end", (event: LettaEvent) => {
      if (!activeRunId || !event || typeof event !== "object") return;
      const toolName = event.toolName;
      const result = event.result;
      if (typeof toolName !== "string" || toolName !== "Agent") return;

      const args = event.args ?? event.arguments;
      if (!args || typeof args !== "object") return;

      const runId = args.run_id ?? args.runId;
      const phaseId = args.phase_id ?? args.phaseId;
      const agentId = args.agent_id ?? args.agentId;
      if (!isNonEmptyString(runId) || !isNonEmptyString(phaseId) || !isNonEmptyString(agentId)) return;
      if (runId !== activeRunId) return;

      const run = loadRun(runId);
      if (!run) return;
      const phase = run.workflow.phases.find((p) => p.id === phaseId);
      if (!phase) return;

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
      try { dispose(); } catch { /* ignore */ }
    }
  };
}

function normalizeCommandArgs(value: string | Record<string, unknown> | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    const text = value.text ?? value.query ?? value.name ?? value.args;
    if (typeof text === "string") return text.trim();
  }
  return null;
}

function normalizeInputs(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined && v !== null) {
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }
  return out;
}

function formatStep(step: ReturnType<typeof stepInlineRun>): string {
  if (!step) return "No step available.";
  if (step.type === "complete") return `Workflow complete. Result: ${step.resultPath}`;
  if (step.type === "dispatch") return `${step.instructions}\n\nAgents:\n${step.agents?.map((a) => `  - ${a.id}: ${a.prompt.slice(0, 120)}...`).join("\n") ?? ""}`;
  if (step.type === "wait") return `Waiting for phase "${step.phaseId}" (${step.completed}/${step.completed + step.pending} complete).`;
  return "Unknown step.";
}
