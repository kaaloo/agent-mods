# @kaaloo/dynamic-workflows

A Letta-native mod for authoring and running multi-agent dynamic workflows.

## What it does

Dynamic Workflows lets you describe a task as a JSON workflow, then run it across multiple parallel subagents with a state machine that tracks progress, synchronizes barriers, and synthesizes results.

## Install

From the package directory:

```bash
cd packages/dynamic-workflows
npm install
```

Then install the mod into Letta Code:

```bash
letta install ./packages/dynamic-workflows
```

Reload mods in Letta Code:

```text
/reload
```

## Usage

Author a workflow:

```text
/workflow-author "scan this codebase for bugs"
# or
/wf-author "scan this codebase for bugs"
```

Save it:

```text
/workflow-save bug-sweep
# or
/wf-save bug-sweep
```

Run it:

```text
/workflow-run bug-sweep
# or
/wf-run bug-sweep
```

List workflows:

```text
/workflow-list
# or
/wf-list
```

Show the panel:

```text
/workflow
# or
/wf
```

## v0.1 status

This is a prototype. v0.1 supports:

- `fan-out` and `barrier` phase types
- Inline execution mode (model dispatches parallel `Agent` calls)
- Workflow authoring, saving, loading, and listing
- A progress panel

Background execution, advanced phase types, and Letta-native integrations (Control Room, Threadkeeper, muscle-memory) are planned for later versions.

## Safety

Mods are trusted local code. Review the source before installing third-party mods.

If a mod breaks startup or command handling, recover with:

```bash
letta --no-mods
# or
LETTA_DISABLE_MODS=1 letta
```
