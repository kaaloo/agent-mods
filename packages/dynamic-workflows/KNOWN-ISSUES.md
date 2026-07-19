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

## 3. Registry writes are not coordinated across runs

**Symptom:** Two concurrent `createRun` calls can race on
`registry.md`. One overwrites the other's entry because `updateRunRegistry`
does `readState → mutate → writeState` under the per-run mutex only — runs
acquire different mutexes, so cross-run registry updates collide.

**Trigger:** High concurrency on a fresh conversation or after a session
restart when multiple workflows start in quick succession.

**Workaround today:** Rare in practice because runs typically start
sequentially from a single user. If you observe lost entries in
`registry.md`, restart the affected run; the run state on disk is
authoritative and `loadRun` does not depend on the registry.

**Status:** Flagged as M1 in the second bug-sweep report, re-confirmed
as H1 / M1 in the fourth and fifth sweeps. Will be fixed as part of
`task_7` (transactional persistRun + cross-run registry mutex design
pass). The current acceptable-risk rating holds: in practice, runs
start sequentially from a single user, so the race window is small.

## 4. Sweep 5 closure-map fix (closed)

The fifth bug-sweep flagged `activeRunId`, `activeRunConversationId`,
and `workflowContinuationCount` as closure-local mutable state (H1) and
the `MAX_WORKFLOW_CONTINUATIONS` check as a TOCTOU race (H2). Both
closed by replacing the closure variables with a per-run
`runMeta: Map<runId, { conversationId, count }>` accessed under
`withRunMutexFor`. The budget check + increment are one atomic block;
the meta entry is cleared when a run reaches terminal state to bound
map growth.

**Status:** Closed in commit `c56f367`.
