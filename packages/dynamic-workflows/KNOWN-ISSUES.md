# Known issues — dynamic-workflows mod

Notes on harness-level quirks and mod-side workarounds. Each entry records
the symptom, the trigger, and the workaround so future contributors don't
rediscover them.

## 1. Orchestrator `Agent` tool calls must include `description`

**Symptom:** A `flow_run` orchestrator prompt that asks the model to dispatch
parallel `Agent` calls is auto-denied on the first call with:

> Agent tool missing required parameter: description

**Trigger:** When the dynamic-workflows orchestrator builds the dispatch
instructions for a fan-out phase, the model receives a list of Agent prompts
to call. On Letta Code ≥ 0.27.x, the harness rejects any `Agent` tool
invocation that omits the `description` parameter. Subsequent calls succeed
once `description` is included.

**Workaround in the mod:** None. The mod does not control how the model
fills in the Agent tool's arguments. The harness enforces this from the
outside.

**Workaround in custom orchestrators:** Any orchestrator prompt that
constructs Agent tool calls must explicitly include a `description` field
for each one, even if the prompt template only asks the model to "use the
Agent tool." Adding a default `description` to the prompt template (e.g.,
"Dispatch a worker to <task>") is enough to satisfy the harness.

**First observed:** 2026-07-18, during the example-bug-sweep run at
`flows/runs/1784385035947-fc110eb9`.

## 2. Per-run mutex re-entry works by design now (closed)

The third bug-sweep flagged the nested acquisition of the per-run mutex
in `dispatchFanOut` / `dispatchBarrier` as Critical (deterministic
self-deadlock under any refactor that breaks the `.then`-scheduling
assumption). The fix splits each public runner API into a thin mutex
wrapper plus an internal `*Locked` helper that assumes the caller
already holds the mutex. `dispatchFanOut` and `dispatchBarrier` now
call the locked variants directly, eliminating the re-acquire.

**Status:** Closed in commit `39ecb0d` ("split public runner APIs from
internal Locked helpers"). Regression tests in
`mods/tests/state-concurrency.test.ts > C1 mutex re-entry safety`
exercise the locked variants inside a single mutex slot with a 5s
deadlock timeout.

The fifth bug-sweep re-flagged this as latent M2 ("deadlock-by-design
under refactor"). The active deadlock is closed; the latent concern is
that a future refactor that switches `withRunMutexFor` to synchronous
acquisition would re-introduce it. The regression tests catch this:
any future change that causes re-entry will time out in CI. Maintainers
should not introduce sync acquisition in `withRunMutexFor` without
removing the re-entrant call sites first.

## 3. Registry writes are not coordinated across runs (closed)

**Symptom:** Two concurrent `createRun` calls can race on
`registry.md`. One overwrites the other's entry because `updateRunRegistry`
does `readState → mutate → writeState` under the per-run mutex only — runs
acquire different mutexes, so cross-run registry updates collide.

**Trigger:** High concurrency on a fresh conversation or after a session
restart when multiple workflows start in quick succession.

**Fix:** All registry read-modify-write operations now run through a
single cross-run registry mutex (`scheduleRegistryUpdate` in `state.ts`).
`updateRunRegistry` and the registry removal in `deleteRun` are serialized,
so concurrent writes cannot lose entries.

**Status:** Closed in sweep-12.

## 5. Accepted hardening gaps from follow-up audit (run `1784469622075-7097da38`)

The follow-up audit after sweeps 13-17 confirmed that all previous High and
Medium findings are closed. The remaining findings are Low/Info hardening
suggestions and accepted limitations for a prototype. We document them here
so they are not re-discovered and re-prioritized in every sweep.

| ID | Finding | Status | Rationale |
|---|---|---|---|
| L-REG | `clearRunMetaLocked` rename | Closed in sweep-17 | Function renamed to document the mutex contract. |
| L-TYPE | `LettaModContext.tools`/`commands` optional | Closed in sweep-17 | Types updated to match the defensive runtime guards. |
| L-SAN1 | `sanitizePromptField` Unicode coverage | Closed in sweep-17 | Regex expanded to include RLO, zero-width spaces, BOM, NEL. |
| L-SAN2 | `flow_save` description sanitization | Closed in sweep-17 | Description sanitized and `saveLibraryEntry` wrapped in try/catch. |
| L-PROMPT | Prior-phase outputs in barrier prompts | Accepted | Sub-agent outputs are part of the intended synthesis input. Applying `sanitizePromptField` would strip legitimate content; delimiter wrapping would be a bigger change. Risk is low because outputs are only used inside the same conversation. |
| L-MODEL | `phase.model` pattern validation | Accepted | `sanitizePromptField` already strips control characters. A model whitelist is too brittle for a prototype because supported model identifiers vary by deployment. |
| L-WDIR | Working directory as arbitrary string | Accepted | The working directory comes from the Letta runtime context (`ctx.cwd` / `ctx.workingDirectory`), which is semi-trusted. The control-character stripping prevents prompt splitting. Validating it as an existing filesystem path would fail workflows launched before the directory exists. |
| L-MEM | Unbounded `runMutexes` map | Accepted | Each entry is a resolved `Promise<void>` with negligible memory cost. The prototype does not run long enough for this to matter. Cleanup can be added if the mod is promoted to production. |
| L-YAML | YAML schema restrictions | Accepted | The `yaml` npm package is safe by default (no `!!js/function`). `validateWorkflow` rejects malformed shapes. Unknown fields pass through but are not accessed. |
| L-DISP | `getRunResultDisplayPath` display-path validation | Accepted | The path is display-only; actual file operations use `getRunDir` which validates both `runId` and `runAgentId`. |
| L-INPUT | `flow_run` inputs not sanitized | Accepted | Inputs are stored in `run.inputs` but are not used in any path, command, or prompt interpolation. Sanitization will be added if a future feature consumes them. |
| L-COERCE | `String()` coercion on YAML fields | Accepted | Remaining `String()` calls are in `loadAgentResult` and similar display fields where equality checks reject mismatches. The fields are not used for path construction or command execution. |
| I-STREAM | Silent `sendMessageStream` failures | Accepted | The fire-and-forget `sendPrompt` pattern is intentional. If the stream fails, the prompt is simply not delivered and the orchestrator will continue on the next `turn_end` poll. |
| I-META | `latestMetaView` stale reads | Accepted | Panel rendering is intentionally asynchronous and best-effort. The worst case is a stale display for one render cycle. |
| I-LOAD | `loadRun` agent directory walk without mutex | Accepted | The directory walk is best-effort. Try/catch blocks prevent crashes, and a transient miss self-corrects on the next poll. |
| I-ERROR | Error messages include user input | Accepted | Tool return values are not public-facing logs; the risk is limited to display issues in the same conversation. |

**Status of these items:** Accepted limitations for the prototype. Re-evaluate if
the mod is promoted to a production-grade feature or if a specific threat model
requires closing one of them.
