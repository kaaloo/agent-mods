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

### `/workflow-author <task>`

Prompts the agent to call `workflow_author` for the described task. The result is a validated JSON workflow definition.

### `/workflow-save <name>`

Saves the most recently authored workflow to the local library.

### `/workflow-list`

Lists saved workflows and bundled example templates.

### `/workflow-run <name> [inputs...]`

Starts an inline run of the named workflow. In v0.1, the model dispatches subagents and the mod tracks completion via events.

### `/workflow`

Shows or hides the progress panel.

## Tools

### `workflow_author`

Read-only tool. Generates a JSON workflow definition for a described task. Returns the validated DSL or errors to fix.

### `workflow_save`

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
