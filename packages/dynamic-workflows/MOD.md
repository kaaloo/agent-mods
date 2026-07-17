---
name: "@kaaloo/dynamic-workflows"
description: "A Letta-native mod for authoring and running multi-agent dynamic workflows."
---

# Dynamic Workflows mod semantics

## When to use

Use this mod when a task benefits from parallel subagents with explicit synchronization:

- codebase-wide audits or bug sweeps
- cross-checked research across multiple sources
- multi-angle analysis before synthesis
- tasks that naturally decompose into independent subtasks

## Behavioral contract

When a workflow is active, the agent should:

1. Use the workflow's phase structure to guide subagent dispatch.
2. Dispatch all agents in a `fan-out` phase in parallel using multiple `Agent` tool calls.
3. Wait for the mod to report a phase complete before starting the next phase.
4. Use `barrier` phases to merge prior phase outputs into a single synthesized result.
5. Treat the progress panel as operational state, not durable memory.
6. Persist reusable workflows to the library via `workflow_save`.

## Commands

### `/flow`

Shows or refreshes the progress panel.

### `/flow-author <task>`

Returns a structured prompt for the model to author a JSON workflow definition.

### `/flow-save <name>`

Saves the most recently authored workflow to the library. In practice, call the `workflow_save` tool directly.

### `/flow-list`

Lists saved workflows and bundled templates.

### `/flow-run <name>`

Starts a visible run in the current conversation. The model will dispatch the workflow's subagents as `Agent` tool calls (so they appear in the UI), then call `workflow_status` to advance phases until completion.

### `/flow-run-fork <name>`

Starts a run in a hidden forked conversation. No subagent cards appear in the current UI, but the workflow executes in the background.

## Tools

### `workflow_author`

Persist a workflow to the local library. Requires approval.

### `workflow_load`

Load a workflow by name. Read-only.

### `workflow_list`

List saved workflows and templates. Read-only.

### `workflow_run`

Start an inline run. Returns a run ID and dispatch instructions for the current phase. Requires approval.

### `workflow_status`

Query the current state of a run. Read-only.

## State

- `~/.letta/mods/dynamic-workflows.state.json` — library index and run registry.
- `~/.letta/workflows/runs/<run_id>/` — per-run plan, checkpoint, and agent outputs.

## Adaptation notes for agents

- Do not import Letta Code internals.
- Use the public mod API and Node built-ins.
- Keep the DSL bounded and validate it before running.
- In v0.1, only `fan-out` and `barrier` phases are supported.
