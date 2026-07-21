import path from "node:path";
import type { LettaModContext, LettaToolContext, LettaCommandContext, LettaEvent, LettaEventHandlerContext } from "./types.ts";
import { authorWorkflow, parseWorkflowMarkdownText, stripMarkdownFences } from "./lib/author.ts";
import {
  createRun,
  loadRun,
  loadLibraryEntry,
  saveLibraryEntry,
  deleteLibraryEntry,
  listLibrary,
  withRunMutexFor,
  type RunState,
} from "./lib/state.ts";
import { stepInlineRun, stepInlineRunLocked, recordAgentCompleteLocked, recordBarrierCompleteLocked, recordAgentFailureLocked, parseFlowAgentMarker, sanitizePromptField, type InlineStep } from "./lib/runner-inline.ts";
import { listTemplates, loadTemplate } from "./lib/templates.ts";
import { isBarrierPhase, isFanOutPhase, phaseById } from "./lib/schema.ts";
import { isNonEmptyString } from "./lib/utils.ts";

export default function activate(letta: LettaModContext): (() => void) {
  const disposers: Array<() => void> = [];
  // Per-run conversation ownership. Mutations happen under the per-run mutex.
  const runMeta = new Map<string, { conversationId: string | undefined }>();
  // Models sometimes omit the [FLOW_AGENT ...] suffix from an Agent prompt.
  // Correlate strictly matched flow dispatches with the stable harness call ID
  // so their tool_end events still reach the right run.
  const flowAgentCalls = new Map<string, FlowAgentRoute>();

  const TEMPLATE_DIR = path.resolve(import.meta.dirname, "../assets/built-in");

  // Coarse mutex for /flow status scans. Per-run mutations remain serialized
  // through withRunMutexFor.
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
        runMeta.set(runId, { conversationId: undefined });
      }
      return fn();
    });
  }

  // Caller must hold the per-run mutex.
  function clearRunMetaLocked(runId: string): void {
    runMeta.delete(runId);
    for (const [toolCallId, route] of flowAgentCalls) {
      if (route.runId === runId) flowAgentCalls.delete(toolCallId);
    }
  }

  async function findUnmarkedFlowAgent(conversationId: string | undefined, prompt: string): Promise<FlowAgentRoute | null> {
    for (const [runId, meta] of runMeta) {
      if (meta.conversationId !== conversationId) continue;
      const route = await withRunMutexFor(runId, () => {
        const run = loadRun(runId);
        return run ? routeForUnmarkedPrompt(run, prompt) : null;
      });
      if (route && !Array.from(flowAgentCalls.values()).some((candidate) => sameRoute(candidate, route))) {
        return route;
      }
    }
    return null;
  }

  function safeOn(event: string, handler: (event: LettaEvent, ctx: LettaEventHandlerContext) => unknown): void {
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
        const run = await createRun(
          workflow,
          normalizeInputs(inputs),
          ctx.conversation?.id,
          ctx.cwd ?? ctx.workingDirectory,
          ctx.model?.id,
          ctx.agent?.id,
        );
        // Record the meta entry under the per-run mutex so concurrent
        // flow_run calls don't trample each other's conversationId.
        await withRunMetaFor(run.runId, async () => {
          runMeta.set(run.runId, { conversationId: ctx.conversation?.id });
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
        return { status: "success", run };
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
              let latest: string | null = null;
              for (const [runId, meta] of runMeta.entries()) {
                if (meta.conversationId === conversationId) latest = runId;
              }
              return latest;
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
            const run = await createRun(
              workflow,
              {},
              ctx.conversation?.id,
              ctx.cwd ?? ctx.workingDirectory,
              ctx.model?.id,
              ctx.agent?.id,
            );
            await withRunMetaFor(run.runId, async () => {
              runMeta.set(run.runId, { conversationId: ctx.conversation?.id });
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
    safeOn("tool_start", async (event: LettaEvent, ctx: LettaEventHandlerContext) => {
      if (!event || typeof event !== "object") return;
      if (typeof event.toolName !== "string" || event.toolName.toLowerCase() !== "agent") return;
      const toolCallId = getToolCallId(event);
      const prompt = getAgentPrompt(event);
      if (!toolCallId || !prompt) return;

      const route = parseFlowAgentMarker(prompt) ?? await findUnmarkedFlowAgent(ctx.conversation?.id, prompt);
      if (route) flowAgentCalls.set(toolCallId, route);
    });

    safeOn("tool_end", async (event: LettaEvent, ctx: LettaEventHandlerContext) => {
      let output = "";
      try {
        if (!event || typeof event !== "object") return;
        if (typeof event.toolName !== "string" || event.toolName.toLowerCase() !== "agent") return;
        output = getAgentOutput(event);

        const toolCallId = getToolCallId(event);
        const marker = parseFlowAgentMarker(getAgentPrompt(event))
          ?? (toolCallId ? flowAgentCalls.get(toolCallId) : undefined);
        if (!marker) return;

        if (event.status === "error") {
          const failure = await withRunMutexFor(marker.runId, () => {
            const meta = runMeta.get(marker.runId);
            if (!meta || ctx.conversation?.id !== meta.conversationId) return null;
            const decision = recordAgentFailureLocked(
              marker.runId,
              marker.phaseId,
              marker.agentId,
              getAgentModel(event),
              output,
            );
            if (toolCallId) flowAgentCalls.delete(toolCallId);
            if (decision?.type === "failed") clearRunMetaLocked(marker.runId);
            return decision;
          });
          if (!failure) return;
          if (failure.type === "retry") {
            return {
              result: {
                status: "error",
                output: `${failure.error}\n\n[FLOW RETRY]\nRetry this exact Agent call once with the model argument omitted so Letta uses Auto. Keep the prompt unchanged and set run_in_background to false.`,
              },
            };
          }
          return {
            result: {
              status: "error",
              output: `${failure.error}\n\n[FLOW FAILED]\nThe workflow is terminally failed. Do not call more flow Agents for this run.`,
            },
          };
        }
        if (event.status !== "success" || !output.trim()) return;

        const nextStep = await withRunMutexFor(marker.runId, async (): Promise<InlineStep | null> => {
          if (toolCallId) flowAgentCalls.delete(toolCallId);
          const meta = runMeta.get(marker.runId);
          if (!meta || ctx.conversation?.id !== meta.conversationId) return null;
          const advance = (): InlineStep | null => {
            const step = stepInlineRunLocked(marker.runId);
            if (step?.type === "complete") clearRunMetaLocked(marker.runId);
            return step;
          };

          if (marker.agentId === "synthesize") {
            const result = recordBarrierCompleteLocked(marker.runId, marker.phaseId, output);
            if (!result) return null;
            if ("type" in result && result.type === "complete") {
              clearRunMetaLocked(marker.runId);
              return result;
            }
            return advance();
          }

          const run = recordAgentCompleteLocked(marker.runId, marker.phaseId, marker.agentId, output);
          if (!run) return null;
          if (run.currentPhaseId !== marker.phaseId || run.status !== "running") {
            return advance();
          }

          // For a batched fan-out, only dispatch the next batch after every
          // foreground Agent in the current batch has returned.
          const phase = phaseById(run.workflow, marker.phaseId);
          if (!phase || !isFanOutPhase(phase)) return null;
          const completed = new Set(
            run.completedAgents
              .filter((agent) => agent.phaseId === marker.phaseId)
              .map((agent) => agent.agentId),
          );
          const hasRunningAgent = phase.agents.some(
            (agent) => run.startedAgentIds.includes(agent.id) && !completed.has(agent.id),
          );
          return hasRunningAgent ? null : advance();
        });

        if (!nextStep) return;
        const continuation = buildInTurnContinuation(marker.runId, nextStep);
        if (!continuation) return;
        return {
          result: {
            status: "success",
            output: `${output}\n\n${continuation}`,
          },
        };
      } catch (err) {
        return {
          result: {
            status: "error",
            output: `${output ? `${output}\n\n` : ""}[FLOW ERROR]\nThe flow event handler failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    });
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* ignore */ }
    }
  };
}

interface FlowAgentRoute {
  runId: string;
  phaseId: string;
  agentId: string;
}

function sameRoute(left: FlowAgentRoute, right: FlowAgentRoute): boolean {
  return left.runId === right.runId && left.phaseId === right.phaseId && left.agentId === right.agentId;
}

function routeForUnmarkedPrompt(run: RunState, prompt: string): FlowAgentRoute | null {
  if (run.status !== "running" || !run.currentPhaseId) return null;
  const phase = phaseById(run.workflow, run.currentPhaseId);
  if (!phase) return null;

  const actual = prompt.trim();
  if (isFanOutPhase(phase)) {
    const agent = phase.agents.find((candidate) => matchesDispatchedPrompt(actual, candidate.prompt));
    return agent ? { runId: run.runId, phaseId: phase.id, agentId: agent.id } : null;
  }

  if (isBarrierPhase(phase) && matchesDispatchedPrompt(actual, phase.prompt)) {
    return { runId: run.runId, phaseId: phase.id, agentId: "synthesize" };
  }

  return null;
}

function matchesDispatchedPrompt(actual: string, basePrompt: string): boolean {
  const expected = sanitizePromptField(basePrompt)?.trim();
  if (!expected) return false;
  return actual === expected || actual.startsWith(`${expected}\n\nWorking directory:`);
}

function getToolCallId(event: LettaEvent): string | undefined {
  const value = event.toolCallId ?? event.tool_call_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getAgentPrompt(event: LettaEvent): string | undefined {
  const args = event.args ?? event.arguments;
  if (args && typeof args === "object") {
    return typeof args.prompt === "string" ? args.prompt : undefined;
  }
  return undefined;
}

function getAgentOutput(event: LettaEvent): string {
  const raw = event.output ?? event.result ?? event.resultText ?? event.reason;
  return typeof raw === "string" ? raw : "";
}

function getAgentModel(event: LettaEvent): string | undefined {
  const args = event.args ?? event.arguments;
  return args && typeof args.model === "string" ? args.model : undefined;
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
  if (step.type === "dispatch") {
    const agents = step.agents?.map((agent) => [
      `Agent ID: ${agent.id}`,
      `Preferred model: ${agent.model ?? "Auto (omit the model argument)"}`,
      `run_in_background: ${agent.runInBackground}`,
      "Prompt:",
      agent.prompt,
    ].join("\n")).join("\n\n") ?? "";
    return `${step.instructions}\n\n${agents}`;
  }
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
---

Phase types: fan-out (parallel agents) and barrier (single agent after dependencies).`;
}

function buildInTurnContinuation(runId: string, step: InlineStep): string | null {
  if (step.type === "complete") {
    return `[FLOW COMPLETE]\n${formatStep(step)}\n\nReturn a concise final summary to the user. Do not call more tools.`;
  }
  const run = loadRun(runId);
  if (!run) return null;
  const prompt = buildExecutorPrompt(runId, run.workflow.name, step);
  return prompt ? `[FLOW CONTINUATION]\n${prompt}` : null;
}

function buildExecutorPrompt(runId: string, workflowName: string, step: InlineStep | null): string | null {
  const run = loadRun(runId);
  if (!run) return null;
  const modelPolicy = run.model
    ? `First try the parent conversation model "${run.model}" for every Agent call.`
    : "The parent conversation model handle is unavailable; use Auto by omitting the Agent model argument.";
  const base = `Workflow "${workflowName}" started. Run ID: ${runId}.\n\nYour job is to execute this workflow to completion in the current conversation. Do not explain your reasoning. Do not ask the user questions. Only use the Agent tool.\n\nExecution context:\n- Working directory: ${run.workingDirectory ?? "the current project directory"}\n- Model policy: ${modelPolicy}\n\nRules:\n1. If step.type is "complete", stop and return a concise summary of the result shown below.\n2. If step.type is "dispatch", issue the described Agent tool calls with the exact prompts provided.\n3. For a fan-out dispatch, issue all Agent calls together in one assistant response so they execute in parallel.\n4. Set run_in_background to false on every Agent call. Never call TaskOutput, poll tasks, or launch a flow Agent in the background.\n5. Try the preferred model first. If an Agent call cannot launch because that model is unknown, unavailable, out of credits, or disallowed by the current plan, retry that call once with the model argument omitted so Letta uses Auto. Do not select a different explicit model.\n6. If step.type is "wait", stop without calling tools; the orchestrator will continue the flow after foreground Agent results are recorded.\n7. Use the general-purpose subagent type for all Agent calls.\n\nCurrent step:`;
  return `${base}\n\n${formatStep(step)}`;
}


