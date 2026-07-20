# @kaaloo/flows

A Letta-native mod for authoring and running multi-agent flows.

## What it does

Flows lets you describe a task as a markdown file with YAML frontmatter, then run it across multiple parallel subagents with a state machine that tracks progress, synchronizes barriers, and synthesizes results.

## Install

From the package directory:

```bash
cd packages/flows
npm install
```

Then install the mod into Letta Code:

```bash
letta install ./packages/flows
```

Reload mods in Letta Code:

```text
/reload
```

## Usage

Generate an authoring prompt:

```text
/flow author "scan this codebase for bugs"
```

Copy the model's workflow markdown output and save it (use the `flow_save` tool, naming the workflow e.g. `code-audit`).

Run a saved or built-in workflow:

```text
/flow run code-audit
```

List saved and built-in workflows:

```text
/flow list
```

Show the most recently active run:

```text
/flow
```

## v0.1 status

This is a prototype. v0.1 supports:

- `fan-out` and `barrier` phase types
- Inline execution mode (model dispatches parallel `Agent` calls)
- Workflow authoring, saving, loading, listing, and status queries

Background execution, advanced phase types, and Letta-native integrations (Control Room, Threadkeeper, muscle-memory) are planned for later versions.

## Safety

Mods are trusted local code. Review the source before installing third-party mods.

If a mod breaks startup or command handling, recover with:

```bash
letta --no-mods
# or
LETTA_DISABLE_MODS=1 letta
```
