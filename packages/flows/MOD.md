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
  max_duration_ms: 600000
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
- Workflows are scoped to the conversation that started them; other conversations will not receive continuation prompts.
