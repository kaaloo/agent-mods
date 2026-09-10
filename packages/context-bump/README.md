# @kaaloo/context-bump

Automatically raises the context window and max output tokens for hosted
[Letta Code](https://github.com/letta-ai/letta-code) model conversations.
No slash command: when a conversation opens, the mod raises both the agent
default and that conversation to the configured targets.

Targets are served from the `squad-mods` shared memory repository at
`context-bump/config.json`, with identical built-in defaults (256k context /
65k output) as a fallback. The mod is raise-only, so it never lowers a higher
manual pin and leaves inherited values alone. See [MOD.md](MOD.md) for the
full mechanism and limitations.

## Install

From this repository (git channel — installs what the repo-root
`package.json#letta` manifest lists):

```bash
letta install git:github.com/kaaloo/agent-mods
```

To make the mod travel with one agent across environments, install into its
MemFS instead:

```bash
letta install git:github.com/kaaloo/agent-mods --agent <agent-id>
```

Or from a local checkout (per-package channel):

```bash
git clone https://github.com/kaaloo/agent-mods.git
cd agent-mods/packages/context-bump
letta install .
```

Reload mods with `/reload` in a running session, or start a new conversation.

## Configuration

Squad-wide config lives at `squad-mods/context-bump/config.json`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `default.contextWindow` | number | `256000` | Target context window |
| `default.maxOutputTokens` | number | `65536` | Target max output tokens |
| `models.<handle>` | object | - | Per-model override (either field) |
| `agents.<agent-id>` | object | - | Per-agent override (either field) |

Precedence: `agents` > `models` > `default`. The built-in defaults match the
`default` block, so the mod works with no shared config present.

## Development

```bash
npm install
npm run verify   # bundle drift check + typecheck + tests
```

Requires [Bun](https://bun.sh) for the bundle step, matching the other
packages in this monorepo.
