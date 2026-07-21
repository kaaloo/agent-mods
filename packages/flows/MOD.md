---
name: "@kaaloo/flows"
description: "A Letta-native mod for authoring and running multi-agent flows."
---

# Flows mod semantics

## When to use

Use this mod when a task benefits from parallel subagents with explicit synchronization:

- codebase-wide audits or bug sweeps
- cross-checked research across multiple sources
- multi-angle analysis before synthesis
- tasks that naturally decompose into independent subtasks

## Workflow format

Workflows are stored as **Markdown files with YAML frontmatter**. The frontmatter contains the structured workflow definition; the Markdown body is reserved for descriptive content.

### Minimal example

```markdown
---
name: my-security-sweep
version: "1"
description: Scan for common security issues and synthesize a report.
phases:
  - id: scan
    type: fan-out
    concurrency: 3
    agents:
      - id: auth
        prompt: Check authentication and authorization bugs.
      - id: input
        prompt: Check input validation and injection risks.
  - id: report
    type: barrier
    depends_on:
      - scan
    prompt: Merge the findings into a prioritized report.
budgets:
  max_concurrent: 3
---

Longer descriptive content about the workflow, intended for humans.
```

### Phase types

- `fan-out`: dispatch all agents in parallel. The phase completes when every agent has finished.
- `barrier`: run a single synthesis agent after all `depends_on` phases complete. The prompt can reference prior phase outputs.

### Authoring your own sweep

1. Use `/flow new <task>` to generate a draft. The model returns a Markdown workflow.
2. Save it with the `flow_save` tool (or `/flow save <name>` as a reminder).
3. Run it with `/flow run <name>`.

## Commands

All commands live under `/flow`:

| Command | Description |
|---------|-------------|
| `/flow` | Show active flow status. |
| `/flow help` | Show quick-start guide. |
| `/flow new <task>` | Author a new workflow. |
| `/flow save <name>` | Reminder to save the generated workflow via `flow_save`. |
| `/flow list` | List saved workflows and bundled templates. |
| `/flow run <name>` | Run a workflow in the current conversation. |
| `/flow delete <name>` | Delete a saved workflow. |

## Tools

### `flow_author`

Generate a workflow definition from a task description.

### `flow_save`

Persist a workflow to the local library. Requires approval. The workflow argument must be a Markdown string with YAML frontmatter.

### `flow_load`

Load a workflow by name. Read-only.

### `flow_list`

List saved workflows and templates. Read-only.

### `flow_run`

Start an inline run. Returns a run ID and dispatch instructions for the current phase. Requires approval.

### `flow_status`

Query the current state of a run. Read-only.

## State

All state lives in the agent's MemFS:

- `~/.letta/agents/<agent-id>/memory/flows/registry.md` — run registry.
- `~/.letta/agents/<agent-id>/memory/flows/library/` — saved workflows.
- `~/.letta/agents/<agent-id>/memory/flows/runs/<run_id>/` — per-run plan, checkpoint, agent outputs, and result.

## Adaptation notes for agents

- Do not import Letta Code internals.
- Use the public mod API and Node built-ins.
- Keep the DSL bounded and validate it before running.
- In v0.1, only `fan-out` and `barrier` phases are supported.
- Every subagent first tries the model from the conversation that started the flow. A failed preferred-model call gets one bounded retry with Auto; a subsequent failure marks the run terminally failed. Per-phase `model` overrides are rejected.
- `max_concurrent` is the only budget supported in workflow version 1. `max_tokens` and `max_duration_ms` are rejected rather than silently ignored.
- `flow_status` is read-only and never steps or dispatches a run.
- Flow Agent calls use `run_in_background: false`. Fan-out calls are issued together for parallel execution; the orchestrator must not poll with `TaskOutput`.
- Subagents return reports through their Agent tool results. The parent mod persists them; subagents do not write into another agent's MemFS.
- The final `tool_end` result for each phase carries the next-phase instruction, keeping continuation in the originating CLI turn.
- Workflows are scoped to the conversation that started them; other conversations will not receive continuation prompts.
