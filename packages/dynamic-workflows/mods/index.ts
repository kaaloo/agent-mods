import path from "node:path";
import type { LettaModContext, LettaToolContext, LettaCommandContext, LettaEvent, LettaEventHandlerContext } from "./types.ts";
import { authorWorkflow, parseWorkflowMarkdownText, stripMarkdownFences } from "./lib/author.ts";
import { renderProgressPanel } from "./lib/panel.ts";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createRun,
  loadRun,
  loadLibraryEntry,
  saveLibraryEntry,
  deleteLibraryEntry,
  listLibrary,
  persistRun,
  setRuntimeAgentId,
  touchRun,
  updateRunRegistry,
  withRunMutexFor,
} from "./lib/state.ts";
import { stepInlineRun, recordAgentComplete, recordBarrierComplete, parseFlowAgentMarker, type InlineStep } from "./lib/runner-inline.ts";
import { listTemplates, loadTemplate } from "./lib/templates.ts";
import { isNonEmptyString } from "./lib/utils.ts";

const PANEL_ID = "flows";

export default function activate(letta: LettaModContext): (() => void) {
  const disposers: Array<() => void> = [];
  let activeRunId: string | null = null;
  let activeRunConversationId: string | undefined = undefined;
  let panel: { update: () => void; close: () => void } | null = null;
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
      name: "flow_author",
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
      name: "flow_save",
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
      name: "flow_load",
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
      name: "flow_list",
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
        // Defensive: a malformed library entry or template could surface with
        // missing name/description. Coerce to safe strings rather than letting
        // toLowerCase() throw on undefined. Closes H1 from the bug-sweep.
        const safeAll = all.map((e) => ({
          name: typeof e.name === "string" && e.name.length > 0 ? e.name : "(unnamed)",
          description: typeof e.description === "string" ? e.description : "",
          source: e.source,
          savedAt: e.savedAt,
        }));
        const filterText = filter ? String(filter).toLowerCase() : "";
        const filtered = !filterText
          ? safeAll
          : safeAll.filter((e) =>
              e.name.toLowerCase().includes(filterText) ||
              e.description.toLowerCase().includes(filterText)
            );
        return { status: "success", workflows: filtered };
      },
    }));

    disposers.push(letta.tools.register({
      name: "flow_run",
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
      async run(ctx: LettaToolContext) {
        if (ctx.agent?.id) setRuntimeAgentId(ctx.agent.id);
        const { name, inputs } = ctx.args || {};
        if (!isNonEmptyString(name)) {
          return { status: "error", content: "name is required" };
        }
        const entry = loadLibraryEntry(name);
        const workflow = entry?.workflow ?? loadTemplate(TEMPLATE_DIR, name);
        if (!workflow) {
          return { status: "error", content: `Workflow "${name}" not found.` };
        }
        const run = await createRun(workflow, normalizeInputs(inputs), ctx.conversation?.id, ctx.cwd ?? ctx.workingDirectory);
        activeRunId = run.runId;
        activeRunConversationId = ctx.conversation?.id;
        workflowContinuationCount = 0;
        refreshPanel();
        const step = await stepInlineRun(run.runId);
        return { status: "success", runId: run.runId, step };
      },
    }));

    disposers.push(letta.tools.register({
      name: "flow_status",
      description: "Query the current state of a run.",
      parameters: {
        type: "object",
        properties: { run_id: { type: "string" } },
        required: ["run_id"],
      },
      approvalPolicy: "auto",
      parallelSafe: true,
      async run(ctx: LettaToolContext) {
        if (ctx.agent?.id) setRuntimeAgentId(ctx.agent.id);
        const { run_id } = ctx.args || {};
        if (!isNonEmptyString(run_id)) {
          return { status: "error", content: "run_id is required" };
        }
        const run = loadRun(run_id);
        if (!run) {
          return { status: "error", content: `Run "${run_id}" not found.` };
        }
        const step = await stepInlineRun(run_id);
        return { status: "success", run, step };
      },
    }));

  }

  // ── Commands ──
  if (letta.capabilities?.commands) {
    disposers.push(letta.commands.register({
      id: "flow",
      description: "Dynamic Workflows: /flow [panel|new|save|list|run|delete|help] — manage multi-agent workflows.",
      args: "[subcommand] [args...]",
      runWhenBusy: true,
      run: async (ctx: LettaCommandContext) => {
        if (ctx.agent?.id) setRuntimeAgentId(ctx.agent.id);
        const raw = normalizeCommandArgs(ctx.args);
        const tokens = raw ? raw.trim().split(/\s+/) : [];
        const subcommand = tokens[0] ?? "panel";
        const rest = tokens.slice(1).join(" ");

        switch (subcommand.toLowerCase()) {
          case "panel":
          case "status": {
            refreshPanel();
            return { type: "output", output: activeRunId ? `Workflow panel active. Run ID: ${activeRunId}` : "No active workflow." };
          }
          case "help":
          case "h": {
            return { type: "output", output: buildFlowHelp() };
          }
          case "new":
          case "author": {
            if (!rest) {
              return { type: "output", output: "Usage: /flow new <task>\n\nExample: /flow new \"security sweep for a TypeScript codebase\"" };
            }
            const { prompt } = authorWorkflow({ task: rest });
            return { type: "output", output: prompt };
          }
          case "save": {
            if (!rest) {
              return { type: "output", output: "Usage: /flow save <name>\n\nAfter /flow new generates a workflow, call the flow_save tool with name=\"<name>\" and the Markdown workflow." };
            }
            return { type: "output", output: `To save the workflow, call the flow_save tool with name="${rest}" and the Markdown workflow definition.` };
          }
          case "list":
          case "ls": {
            const entries = listLibrary();
            const templates = listTemplates(TEMPLATE_DIR);
            const format = (e: { name?: unknown; description?: unknown }) => {
              const name = typeof e.name === "string" && e.name.length > 0 ? e.name : "(unnamed)";
              const description = typeof e.description === "string" ? e.description : "";
              return description.length > 0 ? `  • ${name} — ${description}` : `  • ${name}`;
            };
            const lines = [
              "Saved workflows:",
              ...entries.map(format),
              "Bundled templates:",
              ...templates.map(format),
            ];
            return { type: "output", output: lines.join("\n") };
          }
          case "run": {
            if (!rest) {
              return { type: "output", output: "Usage: /flow run <name>\n\nRun a saved workflow or bundled template." };
            }
            const entry = loadLibraryEntry(rest);
            const workflow = entry?.workflow ?? loadTemplate(TEMPLATE_DIR, rest);
            if (!workflow) {
              return { type: "output", output: `Workflow "${rest}" not found.` };
            }
            const run = await createRun(workflow, {}, ctx.conversation?.id, ctx.cwd ?? ctx.workingDirectory);
            activeRunId = run.runId;
            activeRunConversationId = ctx.conversation?.id;
            workflowContinuationCount = 0;
            refreshPanel();
            const step = await stepInlineRun(run.runId);
            return { type: "prompt", content: buildExecutorPrompt(run.runId, workflow.name, step), systemReminder: true };
          }
          case "delete":
          case "rm": {
            if (!rest) {
              return { type: "output", output: "Usage: /flow delete <name>" };
            }
            deleteLibraryEntry(rest);
            return { type: "output", output: `Deleted workflow "${rest}" from the library.` };
          }
          default: {
            return { type: "output", output: `Unknown subcommand: ${subcommand}\n\n${buildFlowHelp()}` };
          }
        }
      },
    }));
  }

  // ── Events ──
  if (letta.capabilities?.events?.tools) {
    safeOn("tool_end", async (event: LettaEvent, ctx: LettaEventHandlerContext) => {
      if (ctx.agent?.id) setRuntimeAgentId(ctx.agent.id);
      if (!activeRunId || !event || typeof event !== "object") return;
      if (ctx.conversation?.id !== activeRunConversationId) return;
      if (event.toolName !== "Agent" || event.status === "error") return;

      const marker = parseFlowAgentMarker(event.args?.prompt);
      if (!marker || marker.runId !== activeRunId) return;
      const output = typeof event.output === "string" ? event.output : "";
      if (!output.trim()) return;

      if (marker.agentId === "synthesize") {
        await recordBarrierComplete(marker.runId, marker.phaseId, output);
      } else {
        await recordAgentComplete(marker.runId, marker.phaseId, marker.agentId, output);
      }
      refreshPanel();
    });
  }

  if (letta.capabilities?.events?.turns) {
    safeOn("turn_end", async (_event: LettaEvent, ctx: LettaEventHandlerContext) => {
      if (ctx.agent?.id) setRuntimeAgentId(ctx.agent.id);
      const currentRunId = activeRunId;
      const currentConversationId = activeRunConversationId;
      if (!currentRunId) return;
      if (ctx.conversation?.id !== currentConversationId) return;
      const run = loadRun(currentRunId);
      if (!run || run.status !== "running") return;

      const sendPrompt = async (content: string) => {
        const conversation = ctx.conversation;
        const send = conversation?.sendMessageStream;
        if (typeof send !== "function") return;
        try {
          const stream = await send([{ role: "user", content }]);
          void (async () => { try { for await (const _ of stream) { /* discard */ } } catch { /* ignore */ } })();
        } catch { /* ignore */ }
      };

      if (workflowContinuationCount >= MAX_WORKFLOW_CONTINUATIONS) {
        await withRunMutexFor(currentRunId, async () => {
          const refreshed = loadRun(currentRunId);
          if (!refreshed || refreshed.status !== "running") return;
          refreshed.status = "failed";
          refreshed.error = `Exceeded maximum workflow continuations (${MAX_WORKFLOW_CONTINUATIONS}).`;
          persistRun(touchRun(refreshed));
          updateRunRegistry(refreshed);
        });
        await sendPrompt(`Workflow "${run.workflow.name}" stopped: exceeded maximum continuations.`);
        return;
      }

      // Poll the run inline until it is ready to advance. The orchestrator
      // never asks the model to call flow_status during normal execution; the
      // mod drives the loop by reading the run state directly.
      const waitMs = 4000;
      const maxWaitMs = 30000;
      let waited = 0;

      while (waited <= maxWaitMs) {
        const refreshed = loadRun(currentRunId);
        if (!refreshed || refreshed.status !== "running") return;

        const step = await stepInlineRun(currentRunId);
        if (!step) return;

        if (step.type === "complete" || step.type === "dispatch") {
          workflowContinuationCount++;
          await sendPrompt(buildExecutorPrompt(currentRunId, refreshed.workflow.name, step));
          return;
        }

        // step.type === "wait"
        if (waited >= maxWaitMs) {
          await sendPrompt(
            `Workflow "${refreshed.workflow.name}" is waiting for phase "${step.phaseId}" (${step.completed}/${step.completed + step.pending} complete). The orchestrator will check again shortly.`
          );
          return;
        }

        await sleep(waitMs);
        waited += waitMs;
      }
    });
  }

  if (letta.capabilities?.events?.lifecycle) {
    safeOn("conversation_open", () => {
      // Do not auto-resume runs from other conversations. Each run is owned by
      // the conversation that started it; cross-conversation crosstalk is avoided
      // by checking conversation IDs in tool_end and turn_end handlers.
      refreshPanel();
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

function formatStep(step: InlineStep | null): string {
  if (!step) return "No step available.";
  if (step.type === "complete") {
    const resultPreview = step.result
      ? `\n\n${step.result.slice(0, 4000)}${step.result.length > 4000 ? "\n\n[... result truncated; full report at result.md]" : ""}`
      : "";
    return `Workflow complete. Result saved to ${step.resultPath}.${resultPreview}`;
  }
  if (step.type === "dispatch") return `${step.instructions}\n\nAgents:\n${step.agents?.map((a) => `  - ${a.id}: ${a.prompt.slice(0, 120)}...`).join("\n") ?? ""}`;
  if (step.type === "wait") return `Waiting for phase "${step.phaseId}" (${step.completed}/${step.completed + step.pending} complete).`;
  return "Unknown step.";
}

function buildFlowHelp(): string {
  return `Dynamic Workflows — /flow subcommands

  /flow                    — show active workflow status / panel
  /flow help               — show this help
  /flow new <task>          — generate a new workflow for a task
  /flow save <name>        — reminder to save the generated workflow via flow_save
  /flow list               — list saved workflows and bundled templates
  /flow run <name>         — run a workflow in the current conversation
  /flow delete <name>      — delete a saved workflow

Workflows are Markdown files with YAML frontmatter. Example:

---
name: my-sweep
version: "1"
description: One-line description.
phases:
  - id: scan
    type: fan-out
    concurrency: 3
    agents:
      - id: a
        prompt: "Prompt for parallel agent A."
      - id: b
        prompt: "Prompt for parallel agent B."
  - id: synthesize
    type: barrier
    depends_on:
      - scan
    prompt: "Merge the prior outputs into a report."
budgets:
  max_concurrent: 3
  max_duration_ms: 600000
---

Phase types: fan-out (parallel agents) and barrier (single agent after dependencies).`;
}

function buildExecutorPrompt(runId: string, workflowName: string, step: InlineStep | null): string {
  const run = loadRun(runId);
  const base = `Workflow "${workflowName}" started. Run ID: ${runId}.\n\nYour job is to execute this workflow to completion in the current conversation. Do not explain your reasoning. Do not ask the user questions. Only use the Agent tool.\n\nExecution context:\n- Working directory: ${run?.workingDirectory ?? "the current project directory"}\n- Preserve the requested model and working-directory instructions included in each Agent prompt.\n\nRules:\n1. If step.type is "complete", stop and return a concise summary of the result shown below.\n2. If step.type is "dispatch", issue the described parallel Agent tool calls with the exact prompts provided.\n3. If step.type is "wait", wait for the next prompt from the orchestrator. Do not call any tools.\n4. Use the general-purpose subagent type for all Agent calls.\n\nCurrent step:`;
  return `${base}\n\n${formatStep(step)}`;
}


