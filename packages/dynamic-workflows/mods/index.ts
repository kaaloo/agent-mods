import path from "node:path";
import type { LettaModContext, LettaToolContext, LettaCommandContext, LettaEvent, LettaEventHandlerContext } from "./types.ts";
import { authorWorkflow, parseWorkflowMarkdownText, stripMarkdownFences } from "./lib/author.ts";
import { isFanOutPhase, isBarrierPhase } from "./lib/schema.ts";
import { renderProgressPanel } from "./lib/panel.ts";
import {
  createRun,
  loadRun,
  readState,
  loadLibraryEntry,
  saveLibraryEntry,
  listLibrary,
  updateRunRegistry,
} from "./lib/state.ts";
import { stepInlineRun, recordAgentComplete, recordBarrierComplete } from "./lib/runner-inline.ts";
import { listTemplates, loadTemplate } from "./lib/templates.ts";
import { isNonEmptyString } from "./lib/utils.ts";

const PANEL_ID = "dynamic-workflows";

export default function activate(letta: LettaModContext): (() => void) {
  const disposers: Array<() => void> = [];
  let activeRunId: string | null = null;
  let panel: { update: () => void; close: () => void } | null = null;
  let lastTurnWorkflowActivity = false;
  let workflowContinuationCount = 0;
  const MAX_WORKFLOW_CONTINUATIONS = 20;

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
      description: "Save a workflow definition to the local library. The workflow argument should be a Markdown string with YAML frontmatter. Requires approval.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique kebab-case workflow name." },
          workflow: { type: "string", description: "Workflow definition as a Markdown file with YAML frontmatter." },
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
        if (!isNonEmptyString(workflow)) {
          return { status: "error", content: "workflow must be a Markdown string with YAML frontmatter" };
        }
        const cleaned = stripMarkdownFences(workflow);
        const { workflow: validated, error } = parseWorkflowMarkdownText(cleaned);
        if (error) {
          return { status: "error", content: error };
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
        workflowContinuationCount = 0;
        lastTurnWorkflowActivity = false;
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

  }

  // ── Commands ──
  if (letta.capabilities?.commands) {
    disposers.push(letta.commands.register({
      id: "flow",
      description: "Show or refresh the Dynamic Workflows progress panel.",
      run: () => {
        refreshPanel();
        return { type: "output", output: activeRunId ? `Workflow panel active. Run ID: ${activeRunId}` : "No active workflow." };
      },
    }));

    disposers.push(letta.commands.register({
      id: "flow-author",
      description: "Author a new workflow for the given task.",
      args: "<task>",
      run: (ctx: LettaCommandContext) => {
        const args = normalizeCommandArgs(ctx.args);
        if (!args) {
          return { type: "output", output: "Usage: /flow-author <task>" };
        }
        const { prompt } = authorWorkflow({ task: args });
        return { type: "output", output: prompt };
      },
    }));

    disposers.push(letta.commands.register({
      id: "flow-save",
      description: "Save the most recently authored workflow to the library.",
      args: "<name>",
      run: (ctx: LettaCommandContext) => {
        const name = normalizeCommandArgs(ctx.args);
        if (!name) {
          return { type: "output", output: "Usage: /flow-save <name>" };
        }
        return { type: "output", output: `To save a workflow, call the workflow_save tool with name="${name}" and the workflow JSON.` };
      },
    }));

    disposers.push(letta.commands.register({
      id: "flow-list",
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
      id: "flow-run",
      description: "Run a saved workflow in the current conversation. The agent will dispatch the visible subagents and continue until the workflow completes.",
      args: "<name>",
      runWhenBusy: true,
      run: (ctx: LettaCommandContext) => {
        const name = normalizeCommandArgs(ctx.args);
        if (!name) {
          return { type: "output", output: "Usage: /flow-run <name>" };
        }
        const entry = loadLibraryEntry(name);
        const workflow = entry?.workflow ?? loadTemplate(TEMPLATE_DIR, name);
        if (!workflow) {
          return { type: "output", output: `Workflow "${name}" not found.` };
        }
        const run = createRun(workflow);
        activeRunId = run.runId;
        workflowContinuationCount = 0;
        lastTurnWorkflowActivity = false;
        updateRunRegistry(run);
        refreshPanel();
        const step = stepInlineRun(run.runId);
        return { type: "prompt", content: buildExecutorPrompt(run.runId, workflow.name, step), systemReminder: true };
      },
    }));
  }

  // ── Events ──
  if (letta.capabilities?.events?.tools) {
    safeOn("tool_end", (event: LettaEvent) => {
      if (!activeRunId || !event || typeof event !== "object") return;
      const toolName = event.toolName;
      if (typeof toolName !== "string" || toolName !== "Agent") return;
      if (event.status === "error") return;

      const raw = event.output ?? event.resultText ?? event.result;
      const output = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (!output) return;

      const run = loadRun(activeRunId);
      if (!run) return;
      const currentPhaseId = run.currentPhaseId;
      if (!currentPhaseId) return;
      const phase = run.workflow.phases.find((p) => p.id === currentPhaseId);
      if (!phase) return;

      if (isFanOutPhase(phase)) {
        const completedIds = new Set(run.completedAgents.map((a) => a.agentId));
        const pendingAgent = phase.agents.find((a) => !completedIds.has(a.id));
        if (!pendingAgent) return;
        recordAgentComplete(activeRunId, currentPhaseId, pendingAgent.id, output);
      } else if (isBarrierPhase(phase)) {
        recordBarrierComplete(activeRunId, currentPhaseId, output);
      }
      lastTurnWorkflowActivity = true;
      refreshPanel();
    });
  }

  if (letta.capabilities?.events?.turns) {
    safeOn("turn_end", async (_event: LettaEvent, ctx: LettaEventHandlerContext) => {
      if (!activeRunId) return;
      const run = loadRun(activeRunId);
      if (!run || run.status !== "running") return;
      if (!lastTurnWorkflowActivity) return;
      if (workflowContinuationCount >= MAX_WORKFLOW_CONTINUATIONS) return;
      lastTurnWorkflowActivity = false;
      workflowContinuationCount++;
      const conversation = ctx.conversation;
      const send = conversation?.sendMessageStream;
      if (typeof send !== "function") return;
      const step = stepInlineRun(activeRunId);
      const prompt = buildExecutorPrompt(activeRunId, run.workflow.name, step);
      try {
        const stream = await send([{ role: "user", content: prompt }]);
        void (async () => { try { for await (const _ of stream) { /* discard */ } } catch { /* ignore */ } })();
      } catch { /* ignore */ }
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

function buildExecutorPrompt(runId: string, workflowName: string, step: ReturnType<typeof stepInlineRun>): string {
  const base = `Workflow "${workflowName}" started. Run ID: ${runId}.\n\nYour job is to execute this workflow to completion in the current conversation. Do not explain your reasoning. Do not ask the user questions. Only use the workflow_status tool and the Agent tool.\n\nRules:\n1. After each batch of Agent tool calls returns, call workflow_status({ run_id: "${runId}" }) to get the next step.\n2. If step.type is "complete", stop and return a concise summary.\n3. If step.type is "dispatch", issue the described parallel Agent tool calls with the exact prompts provided.\n4. If step.type is "wait", call workflow_status again.\n5. Use the general-purpose subagent type for all Agent calls.\n\nCurrent step:`;
  return `${base}\n\n${formatStep(step)}`;
}

