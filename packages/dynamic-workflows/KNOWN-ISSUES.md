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

## 2. Per-run mutex re-entry works by accident, not by design

**Symptom:** A `stepInlineRun` call may invoke `recordAgentComplete` or
`recordBarrierComplete` re-entrantly. The current implementation handles this
because `withRunMutexFor` schedules the wrapped function via `.then`, which
yields to the event loop before the inner mutex tries to acquire.

**Trigger:** Any future refactor that calls `withRunMutexFor` synchronously
inside its wrapped function (e.g., switching to a `Promise.resolve().then`
chain with eager evaluation) will self-deadlock.

**Workaround:** If you change the mutex implementation, audit every
re-entrant call site (`dispatchFanOut`, `dispatchBarrier`,
`stepInlineRun`'s late-pickup branch) and either pass the in-memory `run`
to a non-locking helper, or split the inner work into a separate
non-mutexed helper that the outer caller invokes after `withRunMutexFor`
releases.

**Status:** Flagged as M3 in the second bug-sweep report
(`flows/runs/1784388655580-35e3c61d/result.md`). Acceptable risk today;
tracked for the transactional-persistRun design pass (`task_7`).

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

**Status:** Flagged as M1 in the second bug-sweep report. Will be fixed
as part of `task_7` (transactional persistRun design pass).
