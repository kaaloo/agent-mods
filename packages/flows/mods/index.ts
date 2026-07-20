import path from "node:path";
import type { LettaModContext, LettaToolContext, LettaCommandContext, LettaEvent, LettaEventHandlerContext } from "./types.ts";
import { authorWorkflow, parseWorkflowMarkdownText, stripMarkdownFences } from "./lib/author.ts";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createRun,
  loadRun,
  loadLibraryEntry,
  saveLibraryEntry,
  deleteLibraryEntry,
  listLibrary,
  persistRun,
  touchRun,
  updateRunRegistry,
  withRunMutexFor,
} from "./lib/state.ts";
import { stepInlineRun, recordAgentCompleteLocked, recordBarrierCompleteLocked, parseFlowAgentMarker, sanitizePromptField, type InlineStep } from "./lib/runner-inline.ts";
import { listTemplates, loadTemplate } from "./lib/templates.ts";
import { isNonEmptyString } from "./lib/utils.ts";

export default function activate(letta: LettaModContext): (() => void) {
  const disposers: Array<() => void> = [];
  // Per-run meta: which conversation owns the run, and how many executor
  // dispatch cycles have been issued. Replaces the previous closure-mutable
  // activeRunId / activeRunConversationId / workflowContinuationCount, which
  // raced across concurrent event handlers (sweep 5 H1, H2). All reads and
  // writes happen under the per-run mutex via withRunMetaFor below.
  const runMeta = new Map<string, { conversationId: string | undefined; count: number }>();
  const MAX_WORKFLOW_CONTINUATIONS = 20;

  const TEMPLATE_DIR = path.resolve(import.meta.dirname, "../assets/built-in");

  // Coarse mutex for runMeta scans used by /flow status and turn_end. Per-run
  // mutations remain serialized through withRunMutexFor.
  const metaMutexChain: { promise: Promise<void> } = { promise: Promise.resolve() };
  function withMetaMutex<T>(fn: () => T): Promise<T> {
    const previous = metaMutexChain.promise;
    const next = previous.then(() => fn(), () => fn());
    metaMutexChain.promise = next.then(() => {}, () => {});
    return next;
  }

  async function withRunMetaFor<T>(runId: string, fn: () => Promise<T> | T): Promise<T> {
    return withRunMutexFor(runId, async () => {
      if (!runMeta.has(runId)) {
        runMeta.set(runId, { conversationId: undefined, count: 0 });
      }
      return fn();
    });
  }

  // Caller must hold the per-run mutex.
  function clearRunMetaLocked(runId: string): void {
    runMeta.delete(runId);
  }

  function safeOn(event: string, handler: (event: LettaEvent, ctx: LettaEventHandlerContext) => void): void {
    try { disposers.push(letta.events.on(event, handler)); } catch { /* ignore */ }
  }

  // ── Tools ──
  if (letta.capabilities?.tools && letta.tools) {
    disposers.push(letta.tools.register({
      name: "flow_author",
      description: "Generate a workflow prompt for the model to author a markdown file with YAML frontmatter defining a workflow.",
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
        try {
          saveLibraryEntry({
            name,
            description: sanitizePromptField(isNonEmptyString(description) ? description : validated.description) ?? validated.description,
            workflow: validated,
            savedAt: new Date().toISOString(),
          });
        } catch (err) {
          return { status: "error", content: `Could not save workflow "${name}": ${err instanceof Error ? err.message : String(err)}` };
        }
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
          return { status: "success", workflow: template, source: "built-in" };
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
        // Record the meta entry under the per-run mutex so concurrent
        // flow_run calls don't trample each other's conversationId.
        await withRunMetaFor(run.runId, async () => {
          runMeta.set(run.runId, { conversationId: ctx.conversation?.id, count: 0 });
        });
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
  if (letta.capabilities?.commands && letta.commands) {
    disposers.push(letta.commands.register({
      id: "flow",
      description: "Flows: /flow [status|new|save|list|run|delete|help] — manage multi-agent flows.",
      args: "[subcommand] [args...]",
      runWhenBusy: true,
      run: async (ctx: LettaCommandContext) => {
        const raw = normalizeCommandArgs(ctx.args);
        const tokens = raw ? raw.trim().split(/\s+/) : [];
        const subcommand = tokens[0] ?? "status";
        const rest = tokens.slice(1).join(" ");

        switch (subcommand.toLowerCase()) {
          case "status": {
            const conversationId = ctx.conversation?.id;
            const activeRunId = await withMetaMutex(() => {
              let best: string | null = null;
              let bestCount = -1;
              for (const [runId, meta] of runMeta.entries()) {
                if (meta.conversationId === conversationId && meta.count > bestCount) {
                  best = runId;
                  bestCount = meta.count;
                }
              }
              return best;
            });
            if (!activeRunId) {
              return { type: "output", output: "No active flow in this conversation." };
            }
            const run = loadRun(activeRunId);
            if (!run) {
              return { type: "output", output: `Flow run "${activeRunId}" is no longer available.` };
            }
            const phase = run.currentPhaseId ? `phase "${run.currentPhaseId}"` : "no active phase";
            return {
              type: "output",
              output: `Flow "${run.workflow.name}" is ${run.status}; ${phase}. Run ID: ${run.runId}`,
            };
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
              "Built-in flows:",
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
            await withRunMetaFor(run.runId, async () => {
              runMeta.set(run.runId, { conversationId: ctx.conversation?.id, count: 0 });
            });
            const step = await stepInlineRun(run.runId);
            const prompt = buildExecutorPrompt(run.runId, workflow.name, step);
            if (!prompt) {
              return { type: "output", output: `Workflow "${rest}" could not be started: run state is no longer available.` };
            }
            return { type: "prompt", content: prompt, systemReminder: true };
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
      if (!event || typeof event !== "object") return;
      if (typeof event.toolName !== "string" || event.toolName.toLowerCase() !== "agent" || event.status !== "success") return;

      const marker = parseFlowAgentMarker(getAgentPrompt(event));
      if (!marker) return;
      const output = getAgentOutput(event);
      if (!output.trim()) return;

      if (marker.agentId === "synthesize") {
        // M1 fix: keep the meta check, the completion write, and the meta
        // cleanup inside a single per-run mutex acquisition so a concurrent
        // turn_end cannot clear the meta entry between the check and the write.
        await withRunMutexFor(marker.runId, async () => {
          const meta = runMeta.get(marker.runId);
          if (!meta) return;
          if (ctx.conversation?.id !== meta.conversationId) return;
          const result = recordBarrierCompleteLocked(marker.runId, marker.phaseId, output);
          if (result && "type" in result && result.type === "complete") {
            sendPrompt(ctx, formatStep(result));
          }
          clearRunMetaLocked(marker.runId);
        });
      } else {
        await withRunMutexFor(marker.runId, async () => {
          const meta = runMeta.get(marker.runId);
          if (!meta) return;
          if (ctx.conversation?.id !== meta.conversationId) return;
          recordAgentCompleteLocked(marker.runId, marker.phaseId, marker.agentId, output);
        });
      }
    });
  }

  if (letta.capabilities?.events?.turns) {
    safeOn("turn_end", async (_event: LettaEvent, ctx: LettaEventHandlerContext) => {
      // Find the run owned by this conversation, atomically. We iterate
      // H-2 from sweep 10: snapshot currentRunId under the meta mutex so
      // a concurrent flow_run cannot change the conversation→run mapping
      // between the scan and the loadRun. The per-run mutex can't be used
      // here because we don't know which runId belongs to this conversation
      // yet — instead we use the coarse meta mutex.
      const currentConversationId = ctx.conversation?.id;
      const currentRunId: string | null = await withMetaMutex(() => {
        for (const [runId, meta] of runMeta.entries()) {
          if (meta.conversationId === currentConversationId) return runId;
        }
        return null;
      });
      if (!currentRunId) return;
      const run = loadRun(currentRunId);
      if (!run || run.status !== "running") return;

      const sendPromptLocal = (content: string) => sendPrompt(ctx, content);

      // The budget check + run-state update happen inside withRunMetaFor so
      // the count read, the limit check, the increment, and any persistence
      // are one atomic block. Closes H2 (TOCTOU on MAX_WORKFLOW_CONTINUATIONS).
      const budgetDecision = await withRunMetaFor(currentRunId, () => {
        const meta = runMeta.get(currentRunId);
        const count = meta?.count ?? 0;
        if (count >= MAX_WORKFLOW_CONTINUATIONS) {
          return { proceed: false as const, count };
        }
        if (meta) meta.count = count + 1;
        return { proceed: true as const, count: count + 1 };
      });

      if (!budgetDecision.proceed) {
        await withRunMutexFor(currentRunId, async () => {
          const refreshed = loadRun(currentRunId);
          if (!refreshed || refreshed.status !== "running") return;
          refreshed.status = "failed";
          refreshed.error = `Exceeded maximum workflow continuations (${MAX_WORKFLOW_CONTINUATIONS}).`;
          persistRun(touchRun(refreshed));
          updateRunRegistry(refreshed);
          // Drop the meta entry on terminal failure. Must run under the
          // mutex so a concurrent tool_end handler can't observe the meta
          // entry after the run has been marked failed.
          clearRunMetaLocked(currentRunId);
        });
        await sendPromptLocal(`Workflow "${run.workflow.name}" stopped: exceeded maximum continuations.`);
        return;
      }

      // Poll the run inline until it is ready to advance. The orchestrator
      // never asks the model to call flow_status during normal execution; the
      // mod drives the loop by reading the run state directly.
      // Gemini review fix: the previous `while (waited <= maxWaitMs)` loop
      // terminated before the timeout check inside the loop body could fire,
      // so the "still waiting" message was unreachable. The loop now runs
      // unconditionally and bails on the timeout check before sleeping.
      const waitMs = 4000;
      const maxWaitMs = 30000;
      let waited = 0;

      while (true) {
        const refreshed = loadRun(currentRunId);
        if (!refreshed || refreshed.status !== "running") return;

        const step = await stepInlineRun(currentRunId);
        if (!step) return;

        if (step.type === "complete" || step.type === "dispatch") {
          const prompt = buildExecutorPrompt(currentRunId, refreshed.workflow.name, step);
          if (!prompt) return;
          await sendPromptLocal(prompt);
          return;
        }

        // step.type === "wait"
        if (waited >= maxWaitMs) {
          await sendPromptLocal(
            `Workflow "${refreshed.workflow.name}" is waiting for phase "${step.phaseId}" (${step.completed}/${step.completed + step.pending} complete). The orchestrator will check again shortly.`
          );
          return;
        }

        await sleep(waitMs);
        waited += waitMs;
      }
    });
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* ignore */ }
    }
  };
}

function getAgentPrompt(event: LettaEvent): string | undefined {
  const args = event.args ?? event.arguments;
  if (args && typeof args === "object") {
    return typeof args.prompt === "string" ? args.prompt : undefined;
  }
  return undefined;
}

function getAgentOutput(event: LettaEvent): string {
  const raw = event.output ?? event.result ?? event.resultText;
  return typeof raw === "string" ? raw : "";
}

function sendPrompt(ctx: LettaEventHandlerContext, content: string): void {
  const send = ctx.conversation?.sendMessageStream;
  if (typeof send !== "function") return;
  void (async () => {
    try {
      const stream = await send([{ role: "user", content }]);
      try { for await (const _ of stream) { /* discard */ } } catch { /* ignore */ }
    } catch { /* ignore */ }
  })();
}

function normalizeCommandArgs(value: string | Record<string, unknown> | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    const text = value.text || value.query || value.name || value.args;
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
  return `Flows — /flow subcommands

  /flow                    — show active flow status
  /flow status             — show active flow status
  /flow help               — show this help
  /flow new <task>          — generate a new flow for a task
  /flow save <name>        — reminder to save the generated flow via flow_save
  /flow list               — list saved and built-in flows
  /flow run <name>         — run a flow in the current conversation
  /flow delete <name>      — delete a saved flow

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

function buildExecutorPrompt(runId: string, workflowName: string, step: InlineStep | null): string | null {
  const run = loadRun(runId);
  if (!run) return null;
  const base = `Workflow "${workflowName}" started. Run ID: ${runId}.\n\nYour job is to execute this workflow to completion in the current conversation. Do not explain your reasoning. Do not ask the user questions. Only use the Agent tool.\n\nExecution context:\n- Working directory: ${run.workingDirectory ?? "the current project directory"}\n- Preserve the requested model and working-directory instructions included in each Agent prompt.\n\nRules:\n1. If step.type is "complete", stop and return a concise summary of the result shown below.\n2. If step.type is "dispatch", issue the described parallel Agent tool calls with the exact prompts provided.\n3. If step.type is "wait", wait for the next prompt from the orchestrator. Do not call any tools.\n4. Use the general-purpose subagent type for all Agent calls.\n\nCurrent step:`;
  return `${base}\n\n${formatStep(step)}`;
}


