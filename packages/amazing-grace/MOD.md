# MOD.md — @kaaloo/amazing-grace

A Letta Code mod for graceful model degradation: it steps an agent down a
priority ladder of usage-plan models when a provider fails, and back up after
recovery. Exception-driven by design — there is no token counting.

## Model ladder (v1)

Priority order, top first. Derived from the 2026-08-19/20 six-model playground
benchmark; `letta/glm` is deliberately excluded for now (it silently drops
image content instead of erroring). The squad-wide ladder lives in the
`squad-mods` shared memory repository at `amazing-grace/config.json`; the same
values ship as built-in defaults for environments where the mount is
unavailable.

| Rung | Handle | Multimodal |
| ---- | ------ | ---------- |
| 1 | `lc-zai-coding/glm-5.3` | no |
| 2 | `lc-qwen-code/qwen3.8-max` | yes |
| 3 | `lc-codex/gpt-5.6-sol` | yes |
| 4 | `lc-minimax/MiniMax-M3` | yes |
| 5 | `lc-kimi-code/k3` | yes |

## Mechanism

- **Failure benches a rung.** Auth errors and unknown handles mark a rung dead
  (until a recovery probe succeeds); quota and rate-limit errors bench it for
  `cooldownMinutes` (default 60).
- **Switching is probe-verified on cloud.** `llm_start`/`llm_end` only fire on
  the local backend, so on the Letta Cloud backend a failed turn triggers a
  probe (forked hidden conversation, ~100-token ping with `overrideModel`) and
  only probe-confirmed failures bench a rung. Transient blips never downgrade.
- **Images downgrade proactively.** GLM-family rungs are text-only (verified:
  Z.ai rejects image parts with a 400). The mod scans turn input at
  `turn_start` and Read-style tool results at `tool_end`; when image content
  is headed for a text-only rung, the conversation is switched to the first
  multimodal rung at or below the current position before the request goes
  out. Image switches are conversation-scoped; failure switches are
  agent-scoped (`updateLlmConfig`).
- **Recovery.** Benched rungs are re-probed at the next `conversation_open`
  after cooldown expiry; a healthy probe revives the rung and the agent climbs
  back up. A still-limited result extends the cooldown.
- **Auto-continue.** After a failure-driven switch, the mod returns
  `{ continue }` from `turn_end` to re-drive the failed request on the new
  model, at most once per 2 minutes per conversation. Disable via config.
- **Ladder enforcement.** Off-ladder models (e.g. `letta/auto`) are switched
  onto the ladder at `conversation_open` when `enforceLadder` is true.
  `/amazing-grace pin <handle>` opts a single agent out.

## Commands

`/amazing-grace [status|pause|resume|pin <handle>|pin off|sync|probe [handle]]`

`status` shows the current rung, config source, benches, and recent events.
`sync` pulls the shared config and re-evaluates immediately. `probe` reports
rung health on demand.

## Shared memory contract

- Reads `squad-mods/amazing-grace/config.json` (change-controlled: Dave
  proposes, Luis approves).
- Writes only its own `squad-mods/amazing-grace/ledger/<agent-id>.json`:
  downgrades, upgrades, image switches, probes, dead marks, recoveries. Events
  are capped at 500. If the mount is missing, the mod clones it via the
  agent's git endpoint; if that fails, it runs on defaults plus a local cache.

## Known limitations

- Image-bearing tool results are inferred from the tool name plus an
  image-extension path (`Read` and `open_files` style tools); unknown tools
  returning images are caught only by the reactive error path.
- A text probe cannot detect image-unsuitability; the reactive path
  compensates by classifying the failed turn's error text first.
- In-session upgrades only happen after `/amazing-grace sync`; automatic
  upgrades apply at the next conversation start.

## Verification

- 46 unit tests (ladder evaluation, classification, detection, state,
  ledger git round-trips including concurrent-push rebase).
- Live probe behavior verified 2026-08-22 against the Letta API:
  `override_model` ping, GLM image 400 shape, qwen3.8-max multimodal,
  unknown-handle error shape.

## Architecture

```
mods/index.ts        runtime: events, commands, panel, decision flow
mods/lib/ladder.ts   config parsing, defaults, rung evaluation
mods/lib/classify.ts provider failure classification
mods/lib/detect.ts   image detection in turn input and tool results
mods/lib/state.ts    benches, pins, and the capped event log
mods/lib/ledger.ts   squad-mods mount, git sync, config/ledger IO
mods/lib/probe.ts    forked overrideModel health probe
```
