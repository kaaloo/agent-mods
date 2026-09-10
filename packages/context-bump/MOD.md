# MOD.md — @kaaloo/context-bump

A Letta Code mod that automatically raises the context window and max output
tokens for hosted Letta model conversations. It runs on conversation open
(with `turn_start` as a fallback surface), needs no slash command, and never
lowers a higher manual pin.

## Mechanism

- **Automatic, no command.** `conversation_open` applies the targets; on
  surfaces without lifecycle events, the first `turn_start` of a conversation
  does the same. Each conversation is applied once per process lifetime.
- **Two scopes.** The agent default is raised once, and each conversation is
  raised independently, so a conversation pinned to a hosted handle does not
  sit at that handle's lower registry default.
- **Raise-only.** A field is patched only when its current value is an
  explicit number below the target. Inherited (`null`/absent) values are left
  alone because the agent-scope raise covers them, and manual pins above the
  target are preserved.
- **Deep merge.** Only `context_window_limit` and
  `model_settings.max_output_tokens` are sent; the server deep-merges
  `model_settings`, preserving `provider_type`, `temperature`, `strict`, and
  other provider settings.

## Shared memory contract

Reads `squad-mods/context-bump/config.json` (change-controlled: Dave proposes,
Luis approves). If the mount is missing, the mod clones it via the agent's git
endpoint; if that fails, it runs on built-in defaults.

```json
{
  "default": { "contextWindow": 256000, "maxOutputTokens": 65536 },
  "models": {
    "lc-deepseek/deepseek-v4-flash": { "contextWindow": 512000, "maxOutputTokens": 393216 }
  },
  "agents": {}
}
```

Precedence is `agents[agentId]` > `models[modelHandle]` > `default`. Omitted
fields inherit from the next level down. Built-in defaults match the
`default` block above, so a fresh install behaves identically with no config.

## Known limitations

- The mod only raises explicit numeric limits. A conversation or agent with
  no explicit limit inherits the agent default, which the mod also raises, so
  the effective value still meets the target.
- A conversation's limits are applied once per process; a model change made
  later in the same process that resets the limits is not re-raised until the
  next conversation or restart. (`updateLlmConfig` model switches on the cloud
  backend do not reset the context window, so this is not triggered by
  model-ladder switching.)
- Errors from the read/update calls are swallowed and reported via
  diagnostics rather than surfacing to the user.

## Verification

- 8 unit tests cover config parsing/target resolution and raise-only patch
  building.
- The live API shape (`context_window_limit`, `model_settings.max_output_tokens`
  deep merge) was verified against the Letta API before implementation.

## Architecture

```
mods/index.ts        runtime: events, panel, raise flow
mods/lib/config.ts   config parsing, defaults, target resolution
mods/lib/limits.ts   raise-only patch building
mods/lib/ledger.ts   squad-mods mount, git sync, config read
```
