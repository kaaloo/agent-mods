# amazing-grace — Analysis and Implementation Plan

Status: implementation ~80% complete on branch `letta/amazing-grace-mod-6b31e8a4`.
Tracking issue: kaaloo/agent-mods#24. This document consolidates the analysis,
the design decisions (with their revision history), the verification evidence,
and the rollout plan.

## 1. Problem

Squad agents run on models sourced through usage-based provider plans. Three
failure modes exist today with no automatic handling:

1. A plan hits its usage limit (429/quota) — sessions fail until a human
   switches models.
2. A subscription lapses (invalid API key) — the rung is dead but keeps
   receiving traffic.
3. GLM-family rungs are text-only — image content fails (or, on the letta-tier
   GLM, is silently dropped, which is worse).

## 2. Model Hierarchy (from the playground benchmark)

The ladder derives from the 2026-08-19/20 six-model evaluation on the
Réfugiés.info playground Agent SDK migration (independent analyses, adversarial
reviews, directive merge). Quality-ordered strength profile:

| Benchmark rank | Model | Strength |
| --- | --- | --- |
| 1 | glm-5.2/5.3 | Densest technical analysis, best API mapping, best merge base |
| 2 | qwen3.8-max | Orchestration, testing strategy, blast-radius, streaming |
| 3 | gpt-5.6-sol | Actionability: adapter pattern, dependency graphs, cutover checklists |
| 4 | MiniMax-M3 | Execution plan structure: 31 tickets, sub-waves, sprint-ready |
| 5 | k3 | Risk identification, best risk-per-word ratio |
| 6 | deepseek-v4-pro | Longest report, fewest actionable artifacts |

Corollary encoded in the design: report size anti-correlates with quality at
the bottom of the ladder.

### Ladder revisions (design conversation, 2026-08-22)

- Initial proposal: benchmark-exact order with `letta/glm` top (ChatGPT-style
  question round) → revised to `lc-zai-coding/glm-5.3` top.
- `letta/glm` **excluded for now** (Luis): its silent image-drop behavior would
  defeat error-driven detection; re-addable via config when needed.
- `deepseek-v4-pro` dropped from the v1 ladder.

### Final v1 ladder (squad-mods/amazing-grace/config.json)

| Rung | Handle | Multimodal |
| --- | --- | --- |
| 1 | `lc-zai-coding/glm-5.3` | no |
| 2 | `lc-qwen-code/qwen3.8-max` | yes |
| 3 | `lc-codex/gpt-5.6-sol` | yes |
| 4 | `lc-minimax/MiniMax-M3` | yes |
| 5 | `lc-kimi-code/k3` | yes |

## 3. Design

Exception-driven degradation: no token counting, no thresholds to calibrate.
Provider failures are ground truth; state changes are rare events, so the
shared-memory log stays cheap while still producing the dataset for later
ladder optimization.

### Mechanism

- **Failure benches a rung.** Auth errors and unknown handles → dead until a
  recovery probe succeeds. Quota/rate-limit → cooldown (default 60 min).
- **Probe-verified classification on cloud.** `llm_start`/`llm_end` fire only
  on the local backend. On cloud, a failed turn triggers a probe: a forked
  hidden conversation, ~100-token ping with `overrideModel`. Only
  probe-confirmed failures bench a rung; transient blips never downgrade.
- **Proactive image downgrading.** `turn_start` scans turn input for image
  parts; `tool_end` infers image-bearing Read-style tool results from an
  image-extension path. Image traffic headed to a text-only rung switches the
  conversation to the first multimodal rung at or below the current position
  before the request goes out.
- **Scopes.** Failure switches are agent-scoped (persist; protect sessions
  where the mod is not loaded). Image switches are conversation-scoped
  (sticky only for the conversation carrying images).
- **Recovery.** Benched rungs are re-probed at the next `conversation_open`
  after cooldown expiry; healthy probe revives and the agent climbs back.
  Still-limited results extend the cooldown. In-session upgrades require
  `/amazing-grace sync` (documented limitation; probes need conversation
  context, so no background timer).
- **Auto-continue.** After a failure-driven switch, `turn_end` returns
  `{ continue }` to re-drive the failed request on the new model — capped at
  one per 2 minutes per conversation. Config flag, default on.
- **Ladder enforcement.** Off-ladder models (e.g. `letta/auto`) are switched
  onto the ladder at `conversation_open` while `enforceLadder` is true.
  Per-agent opt-out: `/amazing-grace pin <handle>`.

### Shared memory (`squad-mods`)

Created 2026-08-22 (`repo-api-a1a55e17-6c52-4299-b661-8d26d34e1284`), attached
read-write to all ten squad agents. Layout:

- `README.md` — loading instructions for agents (read config at decision
  points; treat parse failures as defaults; write only your own ledger file).
- `amazing-grace/config.json` — ladder + policy. Change-controlled: Dave
  proposes, Luis approves.
- `amazing-grace/ledger/<agent-id>.json` — per-agent event log (downgrade,
  upgrade, image-downgrade, probe, dead-mark, recover, config-change), capped
  at 500 events. This is the analysis dataset for optimizing the ladder.

The mod uses the mounted git checkout directly (plain `git pull/push` via the
credential helper the CLI configures — an extra auth header actively breaks
pushes, verified). Missing mount → self-clone via the agent git endpoint →
local cache → built-in defaults, in that order.

### Cross-environment install

Verified against the 0.30.28 parser: git sources are strictly
`git:github.com/owner/repo` — no subdirectories, no `@scope` (so
`git:@kaaloo/packages/<mod>` is invalid). The root `package.json#letta`
manifest governs git installs, and its mod entries may point into
`packages/*`. Channels:

- `letta install git:github.com/kaaloo/agent-mods` — any environment with
  GitHub credentials; installs the whole collection listed by the root
  manifest (all packages' bundled mods; git sources are `owner/repo` only, so
  the root manifest is the collection definition).
- `letta install git:github.com/kaaloo/agent-mods --agent <id>` — installs
  into the agent's MemFS so it travels with the agent across machines.
- `cd packages/amazing-grace && letta install .` — per-package local channel,
  same as existing packages.

## 4. Verification Evidence

Source-verified (letta-code 0.30.28 bundle):

- `updateLlmConfig({ model, scope })` on `ctx.conversation` — shipped
  2026-06-25 (v0.27.17), works on local and cloud backends.
- `turn_end` carries `stopReason: "error"`; its `{ continue }` result injects
  a follow-up user message and re-drives the turn.
- `llm_start`/`llm_end` are local-backend-only (documented in the events
  reference) — hence the probe design.
- Managed-package grammar: `parseManagedGitPackageSource` requires exactly
  owner/repo; manifest entries validated by `isSafeLettaPackageModEntryPath`
  (relative, no traversal, mod extension).

Live-verified (throwaway probe agent, 2026-08-22):

- `override_model` per-request works; non-streaming JSON carries usage stats.
- `lc-zai-coding/glm-5.3` + image → 400 `"messages.content.type is invalid,
  allowed values: ['text']"` (classifiable).
- `letta/glm` + image → silently dropped, model reports no image (why it is
  excluded from v1).
- `lc-qwen-code/qwen3.8-max` + image → correct identification ("Red").
- Unknown handle → `"Model handle not found"` (500).
- Wire format for images is base64 content parts, not OpenAI-style
  `image_url` (both are detected defensively).

Unit tests: 46 passing — ladder evaluation (benching, expiry, multimodal
advance, fallback), classification (verified error strings, no false matches
on embedded numbers), image detection (wire formats, approvals, tool
heuristics), state (round-trip, caps, prune/revive), ledger git round-trips
including concurrent-push rebase.

## 5. Implementation Status

Done (branch `letta/amazing-grace-mod-6b31e8a4`):

- `packages/amazing-grace/mods/` — index.ts runtime (events, commands,
  panel), lib/{ladder,classify,detect,state,ledger,probe}.ts, types.ts
- 5 test files, 46 tests green; `tsc --noEmit` clean; bundle built,
  drift-verified
- `packages/amazing-grace/package.json` — manifest, engines `>=0.28.4` (repo
  convention), scripts matching okf (build/test/typecheck/verify)
- Root `package.json#letta` manifest (git channel)
- `squad-mods` shared repo: created, attached to all 10 agents, scaffolded,
  pushed
- Issue #24 with full problem/scope/acceptance criteria

Remaining:

1. `packages/amazing-grace/MOD.md` (drafted, write was interrupted) and
   `README.md`
2. Root README: Packages table + Installation section updates
3. Local install smoke test (`letta install .` + activation diagnostics)
4. Commit, push, PR referencing issue #24
5. Memory updates and squad announcement

## 6. Rollout Plan

1. Merge PR → `letta install git:github.com/kaaloo/agent-mods --agent <id>`
   per squad agent (MemFS channel; travels across environments).
2. Observe one week via `squad-mods/amazing-grace/ledger/` — event kinds,
   probe results, downgrade frequency, auto-continue outcomes.
3. Tune: ladder order, `cooldownMinutes`, `enforceLadder`, per-agent pins.
   Config changes are commits to squad-mods (change-controlled).
4. Candidate follow-ups: `letta/glm` re-entry when its image handling errors
   rather than drops; deepseek re-entry at the bottom; background recovery
   timer if in-session upgrades matter in practice; aggregate dashboard over
   the ledger.

## 7. Decision Log

| Date | Decision | Context |
| --- | --- | --- |
| 2026-08-22 | Token counting dropped for exception-driven benching | Provider quota errors are ground truth; thresholds would be guesses |
| 2026-08-22 | `letta/glm` excluded from v1 ladder | Silently drops images (no error to catch) |
| 2026-08-22 | deepseek-v4-pro dropped from v1 ladder | Weakest benchmark profile |
| 2026-08-22 | Probes classify failures on cloud | llm events are local-backend-only |
| 2026-08-22 | Image downgrades conversation-scoped, failures agent-scoped | Images are turn-local; failures are sticky |
| 2026-08-22 | Recovery at conversation_open, no background timer | Probes need conversation context to fork |
| 2026-08-22 | Root manifest lists the full mod collection for git installs | Monorepo semantics: the git URL installs the repo's mods, not a single package (Luis revision of the initial amazing-grace-only manifest) |
