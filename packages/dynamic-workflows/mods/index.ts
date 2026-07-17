import type { LettaModContext, ToolCallEndEvent } from "./types.ts";
import { authorWorkflow } from "./lib/author.ts";
import { validateWorkflow, formatValidationErrors } from "./lib/schema.ts";
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
import { isNonEmptyString } from "./lib/utils.ts";

const PANEL_ID = "dynamic-workflows";

export default function dynamicWorkflowsMod(ctx: LettaModContext): void {
  // Shared state for the current conversation.
  let activeRunId: string | null = null;

  ctx.panels.register({
    id: PANEL_ID,
    title: "Dynamic Workflows",
    order: 100,
    content: () => renderProgressPanel(activeRunId) ?? "No active workflow.",
  });

  function refreshPanel(): void {
    try {
      ctx.panels.update(PANEL_ID, renderProgressPanel(activeRunId) ?? "No active workflow.");
    } catch {
      // Panel may not be registered yet on some surfaces; ignore.
    }
  }

  // ── Tools ──

  ctx.tools.register({
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
    handler: ({ task, pattern, hints }) => {
      if (!isNonEmptyString(task)) {
        return { error: "task is required" };
      }
      const { prompt } = authorWorkflow({ task, pattern: pattern as any, hints: hints as string | undefined });
      return { prompt };
    },
  });

  ctx.tools.register({
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
    handler: ({ name, workflow, description }) => {
      if (!isNonEmptyString(name)) {
        return { error: "name is required" };
      }
      const { workflow: validated, errors } = validateWorkflow(workflow);
      if (errors.length > 0) {
        return { error: formatValidationErrors(errors) };
      }
      if (!validated) {
        return { error: "Validation failed" };
      }
      saveLibraryEntry({
        name,
        description: isNonEmptyString(description) ? description : validated.description,
        workflow: validated,
        savedAt: new Date().toISOString(),
      });
      return { name, saved: true };
    },
  });

  ctx.tools.register({
    name: "workflow_load",
    description: "Load a saved workflow definition by name.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    },
    handler: ({ name }) => {
      if (!isNonEmptyString(name)) {
        return { error: "name is required" };
      }
      const entry = loadLibraryEntry(name);
      if (!entry) {
        return { error: `Workflow "${name}" not found.` };
      }
      return { workflow: entry.workflow };
    },
  });

  ctx.tools.register({
    name: "workflow_list",
    description: "List saved workflows and bundled example templates.",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Optional name filter substring." },
      },
    },
    handler: ({ filter }) => {
      const entries = listLibrary();
      const filtered = entries.filter((e) =>
        !filter || e.name.toLowerCase().includes(String(filter).toLowerCase())
      );
      return { workflows: filtered.map((e) => ({ name: e.name, description: e.description, savedAt: e.savedAt })) };
    },
  });

  ctx.tools.register({
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
    handler: ({ name, inputs }) => {
      if (!isNonEmptyString(name)) {
        return { error: "name is required" };
      }
      const entry = loadLibraryEntry(name);
      if (!entry) {
        return { error: `Workflow "${name}" not found.` };
      }
      const run = createRun(entry.workflow, normalizeInputs(inputs));
      activeRunId = run.runId;
      updateRunRegistry(run);
      refreshPanel();
      const step = stepInlineRun(run.runId);
      return { runId: run.runId, step };
    },
  });

  ctx.tools.register({
    name: "workflow_status",
    description: "Query the current state of a run.",
    parameters: {
      type: "object",
      properties: {
        run_id: { type: "string" },
      },
      required: ["run_id"],
    },
    handler: ({ run_id }) => {
      if (!isNonEmptyString(run_id)) {
        return { error: "run_id is required" };
      }
      const run = loadRun(run_id);
      if (!run) {
        return { error: `Run "${run_id}" not found.` };
      }
      const step = stepInlineRun(run_id);
      return { run, step };
    },
  });

  ctx.tools.register({
    name: "workflow_set_ultracode",
    description: "Toggle ultracode mode (v0.2: propose workflows on turn start).",
    parameters: {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
      },
      required: ["enabled"],
    },
    handler: ({ enabled }) => {
      return { ultracode: setUltracode(Boolean(enabled)) };
    },
  });

  // ── Commands ──

  ctx.commands.register({
    name: "workflow-author",
    description: "Author a new workflow for the given task.",
    handler: () => {
      return {
        input: [
          {
            role: "user",
            content: "Call the workflow_author tool with the task you want to turn into a workflow.",
          },
        ],
      };
    },
  });

  ctx.commands.register({
    name: "workflow-save",
    description: "Save the most recently authored workflow to the library.",
    handler: ({ name }: { name?: unknown }) => {
      if (!isNonEmptyString(name)) {
        return { error: "Usage: /workflow-save <name>" };
      }
      return {
        input: [
          {
            role: "user",
            content: `Call the workflow_save tool with name="${name}" and the workflow JSON you just authored.`,
          },
        ],
      };
    },
  });

  ctx.commands.register({
    name: "workflow-list",
    description: "List saved workflows and templates.",
    handler: () => {
      return {
        input: [
          {
            role: "user",
            content: "Call the workflow_list tool.",
          },
        ],
      };
    },
  });

  ctx.commands.register({
    name: "workflow-run",
    description: "Run a saved workflow inline.",
    handler: ({ name }: { name?: unknown }) => {
      if (!isNonEmptyString(name)) {
        return { error: "Usage: /workflow-run <name>" };
      }
      return {
        input: [
          {
            role: "user",
            content: `Call the workflow_run tool with name="${name}".`,
          },
        ],
      };
    },
  });

  ctx.commands.register({
    name: "workflow",
    description: "Show or refresh the workflow progress panel.",
    handler: () => {
      refreshPanel();
      return { panel: PANEL_ID };
    },
  });

  ctx.commands.register({
    name: "ultracode",
    description: "Toggle ultracode mode.",
    handler: ({ enabled }: { enabled?: unknown }) => {
      const value = enabled === "true" || enabled === true || enabled === "on";
      setUltracode(value);
      return { message: `Ultracode ${value ? "enabled" : "disabled"}.` };
    },
  });

  // ── Events ──

  ctx.events.on("tool_end", (event: ToolCallEndEvent) => {
    if (!activeRunId) return;
    if (typeof event !== "object" || !event) return;
    const toolName = event.tool_name;
    const result = event.result;
    if (typeof toolName !== "string") return;
    if (toolName !== "Agent") return;

    // In inline mode, the model dispatches subagents with prompts containing
    // the run_id and phase_id as structured prefixes. We parse them from the
    // tool call arguments if available, otherwise we cannot attribute the result.
    const args = (event as any).args ?? (event as any).arguments;
    if (!args || typeof args !== "object") return;

    const runId = args.run_id ?? args.runId;
    const phaseId = args.phase_id ?? args.phaseId;
    const agentId = args.agent_id ?? args.agentId;
    if (!isNonEmptyString(runId) || !isNonEmptyString(phaseId) || !isNonEmptyString(agentId)) {
      return;
    }

    if (runId !== activeRunId) return;

    const run = loadRun(runId);
    if (!run) return;
    const phase = run.workflow.phases.find((p) => p.id === phaseId);
    if (!phase) return;

    const output = typeof result === "string" ? result : JSON.stringify(result);

    if (phase.type === "fan-out") {
      recordAgentComplete(runId, phaseId, agentId, output);
    } else if (phase.type === "barrier") {
      recordBarrierComplete(runId, phaseId, output);
    }

    refreshPanel();
  });

  ctx.events.on("conversation_open", () => {
    // v0.1: just reload active run from state if any.
    const state = readState();
    const running = Object.entries(state.runs).find(([, r]) => r.status === "running");
    if (running) {
      activeRunId = running[0];
      refreshPanel();
    }
  });
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
