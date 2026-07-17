# Dynamic Workflows Mod — Implementation Plan

**Package:** `@kaaloo/dynamic-workflows`  
**Repo:** `kaaloo/agent-mods`  
**Target engine:** Letta Code `>=0.28.4`  
**Status:** Prototype plan, v0.1

---

## 1. Guiding principles

- **Prototype-first, mod-only.** No runtime PRs until the mod hits a concrete wall.
- **Letta-native.** Design for composition with Control Room, Threadkeeper, and muscle-memory, not feature-parity with Claude.
- **Surgical.** v0.1 is the smallest end-to-end slice that proves the architecture: author → save → run a fan-out → barrier synthesize.
- **No hidden model runs.** Background execution uses `ctx.conversation.fork()` — an explicit forked conversation, not a tool-side hack.

---

## 2. Package layout

```text
packages/dynamic-workflows/
├── package.json
├── package-lock.json
├── README.md
├── MOD.md
├── tsconfig.json
├── mods/
│   ├── index.ts              # entry point: tool/command/event/panel registration
│   ├── lib/
│   │   ├── schema.ts         # Workflow DSL types and validation
│   │   ├── state.ts          # library/run registry + checkpoint persistence
│   │   ├── author.ts         # workflow_author prompt + validation
│   │   ├── runner-inline.ts  # inline execution mode
│   │   ├── runner-bg.ts      # background execution mode (v0.2)
│   │   ├── panel.ts          # progress panel rendering
│   │   └── utils.ts          # id generation, path helpers, safe JSON writes
│   └── tests/
│       ├── schema.test.ts
│       ├── state.test.ts
│       ├── author.test.ts
│       └── runner-inline.test.ts
└── assets/
    └── templates/
        └── example-bug-sweep.json
```

---

## 3. Package manifest

```json
{
  "name": "@kaaloo/dynamic-workflows",
  "version": "0.1.0",
  "keywords": ["letta-package", "letta-mod"],
  "letta": {
    "manifestVersion": 1,
    "mods": ["./mods/index.ts"],
    "capabilities": [
      "tools",
      "commands",
      "events.tools",
      "events.lifecycle",
      "events.turns",
      "ui.panels"
    ],
    "engines": {
      "lettaCodeCli": ">=0.28.4"
    }
  }
}
```

---

## 4. Workflow DSL (v0.1)

JSON, validated by the mod. Two phase types in v0.1; more later.

```ts
interface WorkflowDefinition {
  name: string;
  version: "1";
  description: string;
  phases: Phase[];
  budgets?: {
    max_tokens?: number;
    max_concurrent?: number;
    max_duration_ms?: number;
  };
}

type Phase = FanOutPhase | BarrierPhase;

interface FanOutPhase {
  id: string;
  type: "fan-out";
  model?: string;            // e.g. "anthropic/claude-sonnet-4-6"
  concurrency?: number;      // per-phase override
  agents: Array<{
    id: string;
    prompt: string;
    output_schema?: object;  // JSON schema hint for structured output
  }>;
}

interface BarrierPhase {
  id: string;
  type: "barrier";
  depends_on: string[];      // phase ids to wait for
  model?: string;
  prompt: string;            // prompt with access to prior phase outputs
}
```

Validation rules:
- Phase IDs are unique.
- `depends_on` resolves to existing phases.
- No cycles (v0.1 only allows linear fan-out → barrier).
- `max_concurrent` defaults to `4` and is capped by the global background task ceiling.

Example:

```json
{
  "name": "codebase-bug-sweep",
  "version": "1",
  "description": "Sweep src/ for race conditions, null derefs, and injection vectors.",
  "phases": [
    {
      "id": "scan",
      "type": "fan-out",
      "model": "anthropic/claude-sonnet-4-6",
      "agents": [
        { "id": "race", "prompt": "Scan src/ for race conditions." },
        { "id": "null", "prompt": "Scan src/ for null dereference risks." },
        { "id": "inject", "prompt": "Scan src/ for injection vectors." }
      ]
    },
    {
      "id": "synthesize",
      "type": "barrier",
      "depends_on": ["scan"],
      "model": "anthropic/claude-opus-4-8",
      "prompt": "Merge the scan findings into a single prioritized report."
    }
  ]
}
```

---

## 5. v0.1 mod surface

### Tools (agent-callable)

| Tool | Purpose | Risk |
|---|---|---|
| `workflow_author(task, pattern?, hints?)` | Model emits a workflow DSL for the described task. | Read-only, `parallelSafe: true` |
| `workflow_save(name, workflow, description?)` | Persist a workflow to the local library. | Mutating, `requiresApproval: true` |
| `workflow_load(name)` | Load a saved workflow. | Read-only |
| `workflow_list(filter?)` | List saved workflows and example templates. | Read-only |
| `workflow_run(workflow, inputs?, options?)` | Start an inline run; returns run_id + first-phase dispatch. | Mutating, `requiresApproval: true` |
| `workflow_status(run_id)` | Query run state. | Read-only |

### Commands (human-invoked)

| Command | Type | Notes |
|---|---|---|
| `/workflow-author <task>` | prompt | Becomes the next agent turn asking it to call `workflow_author`. |
| `/workflow-save <name>` | output | Saves the most recently authored workflow. |
| `/workflow-list` | output | Lists library + templates. |
| `/workflow-run <name> [inputs...]` | output | Starts an inline run. |
| `/workflow` | panel command | Show/hide the progress panel. |

### Events

| Event | Use |
|---|---|
| `tool_end` | When the model dispatches parallel `Agent` calls as part of an inline run, record completion and advance the phase. |
| `conversation_open` | Resume any incomplete runs from prior sessions (background mode in v0.2). |
| `turn_start` | v0.2+ — propose a workflow when ultracode mode is on. |

### Panel

A compact persistent panel at `order: 100`:

```text
workflows  [codebase-bug-sweep]  scan ████████░░ 8/12  42k tokens
            synthesize pending
```

Renders from the run registry updated by `tool_end` events.

---

## 6. Inline execution mode (v0.1)

The model is the orchestrator. The mod is the state machine and dispatcher.

```text
user:   /workflow-run codebase-bug-sweep
mod:    creates run_id, persists plan.json, returns first-phase instructions
model:  Agent({subagent_type: "general-purpose", prompt: "Scan src/ for race conditions."})
        Agent({subagent_type: "general-purpose", prompt: "Scan src/ for null dereference risks."})
        Agent({subagent_type: "general-purpose", prompt: "Scan src/ for injection vectors."})
mod:    tool_end fires for each; when all agents in phase complete, mark phase done
model:  workflow_status(run_id) or workflow_run(run_id, next_phase)
mod:    returns barrier phase instructions
model:  Agent({subagent_type: "fork", prompt: "Merge findings..."})
mod:    on completion, writes result.md and marks run complete
```

Why inline first? It is debuggable. The model's own tool-calling loop handles the parallel dispatch; we only track state. Once inline is solid, we add background mode.

---

## 7. State persistence

Two files:

- `~/.letta/mods/dynamic-workflows.state.json` — library index, ultracode toggle, run registry.
- `~/.letta/workflows/runs/<run_id>/` — per-run state:
  - `plan.json` — frozen workflow definition
  - `phases/<phase_id>/<agent_id>.json` — agent prompt, output, status, tokens
  - `result.md` — final synthesized output
  - `checkpoint.json` — current phase index, completed agents, budgets

All writes are atomic: write to a temp file, then rename.

---

## 8. Phased rollout

### v0.1 — Core prototype (this PR)

- Fan-out and barrier phase types.
- Author/save/load/list tools + commands.
- Inline execution mode.
- Simple progress panel.
- State persistence.
- Example bug-sweep template.
- Vitest tests for pure helpers (schema, state, author validation).

### v0.2 — Background mode

- `runWhenBusy: true` `/workflow-run` command.
- Forked-conversation orchestrator.
- Cross-session resume via `conversation_open`.
- `letta cron` integration for very long runs.
- `/ultracode` toggle and `turn_start` proposal.

### v0.3 — Advanced patterns

- Phase types: `pipeline`, `tournament`, `route`, `loop`.
- Per-phase model routing.
- Adversarial verification pattern.
- Skill-distributed workflow templates.

### v0.4 — Letta-native integration

- Control Room hooks: workflow goal, mode, verification state.
- Threadkeeper anchors for live workflow commitments.
- muscle-memory learns reusable workflow prompts from successful runs.

---

## 9. Dynamic mod generation (deferred)

Agent-generated mods are a documented Letta pattern (see [docs.letta.com/letta-agent/mods](https://docs.letta.com/letta-agent/mods)), but they are intentionally **out of scope for v0.1–v0.3**. The JSON DSL is safer and easier to validate.

When the time comes, there are two designs to consider:

1. **Mod builder (recommended for reusable logic).** A command or tool generates a separate mod file under `~/.letta/mods/generated/`, validates/type-checks it, writes it atomically, and asks the user for approval before they run `/reload`.
2. **Conditional registration (recommended for runtime variation).** The single `dynamic-workflows` mod registers and configures capabilities dynamically without generating source code.

Guardrails for generated mods:

- Treat them as fully trusted code with local access.
- Never overwrite the currently executing mod in place.
- Avoid automatic generation → reload → generation loops.
- Use deterministic names/ownership metadata and refuse collisions with human-authored mods.
- Keep rollback copies and surface diagnostics.
- Require review/approval before activating code derived from external or untrusted input.

---

## 10. Testing strategy

- **Unit tests** for `schema.ts`, `state.ts`, `author.ts` using Vitest.
- **Smoke tests** that load the mod in a fresh conversation and verify `/workflow` appears in autocomplete.
- **Manual tests** for the inline execution flow against a small repo.
- **No background-mode tests** in v0.1; that comes in v0.2.

Run locally:

```bash
cd packages/dynamic-workflows
npm install
npm run typecheck
npm test
npm run check
```

---

## 11. Open questions / risks

1. **Fork availability.** `ctx.conversation.fork()` is available in commands and events. v0.1 doesn't need it; v0.2 does. We need to verify it works in the inline execution context first.
2. **Background task ceiling.** The default `maxRunningTasks` may limit concurrent subagents. We need to measure it before promising high concurrency.
3. **Task notification reliability.** Background subagent completion notifications may not reach all surfaces equally. Test TUI, Desktop, headless.
4. **Constellation vs local.** `llm_end` events are local-backend only. Token accounting for cloud agents needs a different approach.
5. **Model output schema enforcement.** The mod can request JSON output, but subagents may return markdown. We need a tolerant parser.
6. **Reload requirement.** Every mod install or generated mod requires `/reload` and usually a new conversation. There is no programmatic reload API.

---

## 12. Success criteria for v0.1

A user can:

1. Install the mod from the worktree.
2. Run `/workflow-author "scan this codebase for bugs"` and get a valid JSON workflow.
3. Run `/workflow-save bug-sweep` to persist it.
4. Run `/workflow-run bug-sweep` and see the model dispatch parallel agents.
5. See the panel update as agents complete.
6. Receive a final `result.md` with the synthesized report.

If v0.1 hits these six criteria, we have a working prototype and can decide whether to escalate any of the open questions to the Letta team.
