# @kaaloo/amazing-grace

Graceful model degradation for [Letta Code](https://github.com/letta-ai/letta-code).
Steps an agent down a priority ladder of usage-plan models when a provider
fails (usage limit, invalid API key, text-only rung receiving images) and back
up after recovery. Exception-driven: no token counting, no thresholds.

## How it works

The ladder (v1: `lc-zai-coding/glm-5.3` → `lc-qwen-code/qwen3.8-max` →
`lc-codex/gpt-5.6-sol` → `lc-minimax/MiniMax-M3` → `lc-kimi-code/k3`) is
served from the `squad-mods` shared memory repository, with identical built-in
defaults as fallback. On failure the mod benches the rung (quota → 60-minute
cooldown; auth/invalid-handle → dead until a probe succeeds) and switches the
agent to the next healthy rung. Image content headed for the text-only GLM
rung switches that conversation to the first multimodal rung before the
request goes out. On the cloud backend, where provider-level events do not
fire, failures are confirmed by a tiny forked probe before anything is
benched. See [MOD.md](MOD.md) for the full mechanism and limitations.

The mod logs every downgrade, upgrade, image switch, probe, and recovery to
its per-agent ledger in `squad-mods` (`amazing-grace/ledger/<agent-id>.json`)
— the dataset for later ladder and policy optimization.

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
cd agent-mods/packages/amazing-grace
letta install .
```

Reload mods with `/reload` in a running session, or start a new conversation.

## Commands

`/amazing-grace status` — current rung, config source, benches, recent events
`/amazing-grace pause` / `resume` — suspend or restore automatic switching
`/amazing-grace pin <handle>` / `pin off` — pin one model or return to the ladder
`/amazing-grace sync` — pull the shared config and re-evaluate now
`/amazing-grace probe [handle]` — probe one rung (or all) and report health

## Configuration

Squad-wide config lives at `squad-mods/amazing-grace/config.json`:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `ladder[].handle` | string | - | Model handle, priority order (top first) |
| `ladder[].multimodal` | boolean | `true` | Rung accepts image content |
| `cooldownMinutes` | number | `60` | Minutes a quota-limited rung stays benched |
| `autoContinue` | boolean | `true` | Auto-retry a failed turn once after a switch |
| `probeEnabled` | boolean | `true` | Use forked pings to classify and recover |
| `enforceLadder` | boolean | `true` | Move off-ladder models onto the ladder |

Ladder position and health are rendered by the order-0 statusline mod
(`~/.letta/mods/statusline.tsx`) from the local state cache, keeping the
indicator on the same line as the host's `agent · model` row.

## Development

```bash
npm install
npm run verify   # bundle drift check + typecheck + tests
```

Requires [Bun](https://bun.sh) for the bundle step, matching the other
packages in this monorepo.
