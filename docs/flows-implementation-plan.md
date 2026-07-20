# Flows Mod — Implementation Plan

**Package:** `@kaaloo/flows`  
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
packages/flows/
├── package.json
├── package-lock.json
├── README.md
├── MOD.md
├── tsconfig.json
├── mods/
│   ├── index.ts              # entry point: tool/command/event registration
│   ├── lib/
│   │   ├── schema.ts         # Workflow DSL types and validation
│   │   ├── state.ts          # library/run registry + checkpoint persistence
│   │   ├── author.ts         # flow_author prompt + validation
│   │   ├── runner-inline.ts  # inline execution mode
│   │   ├── runner-bg.ts      # background execution mode (v0.2)
│   │   ├── utils.ts          # id generation, path helpers, safe YAML frontmatter writes
│   └── tests/
│       ├── schema.test.ts
│       ├── state.test.ts
│       ├── author.test.ts
│       └── runner-inline.test.ts
└── assets/
    └── built-in/
        └── code-audit.md
```

---

## 3. Package manifest

```json
{
  "name": "@kaaloo/flows",
  "version": "0.1.0",
  "keywords": ["letta-package", "letta-mod"],
  "letta": {
    "manifestVersion": 1,
    "mods": ["./mods/index.bundled.mjs"],
    "capabilities": [
      "tools",
      "commands",
      "events.tools"
    ],
    "engines": {
      "lettaCodeCli": ">=0.28.4"
    }
  }
}
```

---

## 4. Workflow DSL (v0.1)

YAML frontmatter in a markdown file, validated by the mod. Two phase types in v0.1; more later.

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
  prompt: string;            // prompt with access to prior phase outputs
}
```

Validation rules:
- Phase IDs are unique.
- `depends_on` resolves to existing phases.
- No cycles (v0.1 only allows linear fan-out → barrier).
- Per-phase `model` overrides are rejected. Every Agent call first tries the `ctx.model.id` captured from the conversation that starts the run, then retries once with Auto if that model cannot launch.
- `max_concurrent` defaults to `4` and is capped by the global background task ceiling.

Example:

```markdown
---
name: code-audit
version: "1"
description: Sweep a codebase for concurrency bugs, null dereference risks, and injection vectors.
phases:
  - id: scan
    type: fan-out
    concurrency: 3
    agents:
      - id: race
        prompt: Scan the codebase for concurrency bugs such as race conditions, deadlocks, and unsynchronized shared state.
      - id: "null"
        prompt: Scan the codebase for null or undefined dereference risks such as unchecked optional values.
      - id: inject
        prompt: Scan the codebase for injection vectors such as SQL injection, command injection, and unsafe eval.
  - id: synthesize
    type: barrier
    depends_on:
      - scan
    prompt: Merge the findings from the race, null, and injection scans into a single prioritized report.
---

Sweep src/ for race conditions, null derefs, and injection vectors,
then synthesize the results.
```

---

## 5. v0.1 mod surface

### Tools (agent-callable)

| Tool | Purpose | Risk |
|---|---|---|
| `flow_author(task, pattern?, hints?)` | Model emits a workflow markdown file for the described task. | Read-only, `parallelSafe: true` |
| `flow_save(name, workflow, description?)` | Persist a workflow to the local library. | Mutating, `approvalPolicy: "alwaysAsk"` |
| `flow_load(name)` | Load a saved workflow. | Read-only |
| `flow_list(filter?)` | List saved workflows and built-in examples. | Read-only |
| `flow_run(name, inputs?)` | Start an inline run; returns run_id + first-phase dispatch. | Mutating, `approvalPolicy: "alwaysAsk"` |
| `flow_status(run_id)` | Query run state. | Read-only |

### Commands (human-invoked)

| Command | Type | Notes |
|---|---|---|
| `/flow author <task>` | output | Prints the authoring prompt for the model. |
| `/flow save <name>` | output | Reminds the user to call `flow_save` with the workflow markdown. |
| `/flow list` | output | Lists library + built-in workflows. |
| `/flow run <name> [inputs...]` | prompt | Starts an inline run and emits the dispatch instructions. |
| `/flow` | output | Shows the active flow status for the current conversation. |

### Events

| Event | Use |
|---|---|
| `tool_end` | Persist foreground `Agent` outputs and append the next phase to the final tool result so the flow continues in the same CLI-owned turn. |

---

## 6. Inline execution mode (v0.1)

The model is the orchestrator. The mod is the state machine and dispatcher. Agent calls use `run_in_background: false`; fan-out calls are emitted together so they execute concurrently without `TaskOutput` polling.

```text
user:   /flow run code-audit
mod:    creates run_id, persists plan.md, returns first-phase instructions
model:  Agent({subagent_type: "general-purpose", prompt: "Scan src/ for race conditions.", run_in_background: false})
        Agent({subagent_type: "general-purpose", prompt: "Scan src/ for null dereference risks.", run_in_background: false})
        Agent({subagent_type: "general-purpose", prompt: "Scan src/ for injection vectors.", run_in_background: false})
mod:    tool_end persists each result; the final result marks the phase done and carries barrier instructions
model:  receives the continuation in the same turn without polling
model:  Agent({subagent_type: "general-purpose", prompt: "Merge findings...", run_in_background: false})
mod:    on completion, writes result.md and marks run complete
```

Why inline first? It is debuggable. The model's own tool-calling loop handles the parallel dispatch; we only track state. Once inline is solid, we add background mode.

---

## 7. State persistence

Two files:

- `~/.letta/workflows/registry.md` — run registry (YAML frontmatter).
- `~/.letta/workflows/runs/<run_id>/` — per-run state:
  - `plan.md` — frozen workflow definition (YAML frontmatter markdown)
  - `phases/<phase_id>/<agent_id>.md` — agent prompt, output, status, tokens (YAML frontmatter markdown)
  - `result.md` — final synthesized output
  - `run.md` — current phase index, completed agents, budgets (YAML frontmatter markdown)

All writes are atomic: write to a temp file, then rename.

---

## 8. Phased rollout

### v0.1 — Core prototype (this PR)

- Fan-out and barrier phase types.
- Author/save/load/list tools + commands.
- Inline execution mode.
- On-demand flow status via `/flow` and `/flow status`.
- State persistence.
- Example code-audit built-in workflow.
- Vitest tests for pure helpers (schema, state, author validation).

### v0.2 — Background mode

- `runWhenBusy: true` `/flow run` command.
- Forked-conversation orchestrator.
- Cross-session resume via `conversation_open`.
- `letta cron` integration for very long runs.
- `/ultracode` toggle and `turn_start` proposal.

### v0.3 — Advanced patterns

- Phase types: `pipeline`, `tournament`, `route`, `loop`.
- Adversarial verification pattern.
- Skill-distributed workflow templates.

### v0.4 — Letta-native integration

- Control Room hooks: workflow goal, mode, verification state.
- Threadkeeper anchors for live workflow commitments.
- muscle-memory learns reusable workflow prompts from successful runs.

---

## 9. Dynamic mod generation (deferred)

Agent-generated mods are a documented Letta pattern (see [docs.letta.com/letta-agent/mods](https://docs.letta.com/letta-agent/mods)), but they are intentionally **out of scope for v0.1–v0.3**. The YAML frontmatter DSL is safer and easier to validate.

When the time comes, there are two designs to consider:

1. **Mod builder (recommended for reusable logic).** A command or tool generates a separate mod file under `~/.letta/mods/generated/`, validates/type-checks it, writes it atomically, and asks the user for approval before they run `/reload`.
2. **Conditional registration (recommended for runtime variation).** The single `flows` mod registers and configures capabilities dynamically without generating source code.

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
- **Smoke tests** that load the mod in a fresh conversation and verify `/flow` appears in autocomplete.
- **Manual tests** for the inline execution flow against a small repo.
- **No background-mode tests** in v0.1; that comes in v0.2.

Run locally:

```bash
cd packages/flows
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
2. Run `/flow author "scan this codebase for bugs"` and get a valid YAML workflow.
3. Run `/flow save <name>` with the workflow markdown to persist it.
4. Run `/flow run <name>` and see the model dispatch parallel agents.
5. Query the active flow state with `/flow status`.
6. Receive a final `result.md` with the synthesized report.

If v0.1 hits these six criteria, we have a working prototype and can decide whether to escalate any of the open questions to the Letta team.
