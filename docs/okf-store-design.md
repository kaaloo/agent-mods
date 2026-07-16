# OKF-Store: A MemFS-style mod for global organizational knowledge

**Status:** Draft design, v0.1
**Repo:** `kaaloo/agent-mods` (new)
**Package name:** `@kaaloo/okf-store`
**Target engine:** Letta Code `>=0.28.4`
**Format:** OKF v0.1 (https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

## 1. Problem statement

Agents need a way to *promote* insights from their own reflection ("dreaming") into shared organizational knowledge that other agents, including future versions of themselves, can act on. Today, the closest pattern in our environment is a rule file dropped into a per-agent memory block — but those are:

- Per-agent, not shared.
- Implicit in the persona/rules structure, not first-class concepts.
- Hard to inspect, audit, or compose across agents.

We need a global, auditable, format-conformant store that any agent in any conversation can:

1. **Read from** when working on a relevant task (keyword search, triggered-rule load).
2. **Write to** when an insight from reflection should be promoted to shared knowledge.
3. **Be inspected by humans** through a CLI/slash-command surface.

The store must be minimal — a directory of markdown + YAML frontmatter — so it stays portable, diffable, and agent-friendly without a separate schema registry.

## 2. Goals and non-goals

### Goals

- **Single canonical bundle** with one designated writer (the mod).
- **OKF v0.1 conformant** by default. No proprietary extensions in v1.
- **Multi-agent, multi-machine**: any conversation on any host with the mod can read; the canonical store is reachable from any host via the cloud git endpoint.
- **Auditable**: every write is committed with author identity, timestamp, and a human-readable `log.md` entry.
- **Promote-from-reflection**: a structured tool call that takes a subagent's insight and writes it to the bundle.
- **No steward agent.** The mod is the only writer. The store is not conversational.

### Non-goals

- **No curator persona.** We're not building a chat surface for "ask the corpus." That's a different product.
- **No taxonomy of concept types.** OKF v0.1 says types are free strings. We will pick a small set for our use cases but the format itself is type-agnostic.
- **No federated/peer-to-peer model.** Single canonical bundle, single designated writer.
- **No schema registry.** Anything beyond OKF's `type` is producer-defined frontmatter. Consumers must tolerate unknown fields.
- **No semantic search in v1.** Keyword search only. QMD/hybrid is a v2 consideration.

## 3. Architecture

### 3.1 Layered model

```
┌─────────────────────────────────────────────────────────┐
│ User-agents (any conversation on a host with the mod)  │
│   ├─ read:  okf_search, okf_load_rule                  │
│   └─ write: okf_propose (via structured dream capture) │
├─────────────────────────────────────────────────────────┤
│ Mod (okf-store) — host-level trusted code              │
│   ├─ owns: bundle validation, secret scan, dedup       │
│   ├─ writes: directly to local bundle clone           │
│   └─ commits: per-write, stable author identity        │
├─────────────────────────────────────────────────────────┤
│ Anchor agent — designated Letta Code agent             │
│   ├─ hosts: the bundle in its MemFS                    │
│   ├─ exposes: cloud git endpoint for cross-host clone  │
│   └─ is a passive holder; never writes to itself       │
├─────────────────────────────────────────────────────────┤
│ OKF bundle — directory of .md files + frontmatter      │
│   ├─ required frontmatter: type                        │
│   ├─ reserved: index.md, log.md                        │
│   └─ everything else: producer-defined, opaque         │
└─────────────────────────────────────────────────────────┘
```

The four layers have distinct responsibilities:

- **User-agents** are consumers and proposers. They never write to disk directly — every promotion goes through `okf_propose` so validation is centralized.
- **The mod** is the only writer. It enforces OKF conformance, secret scanning, path safety, and frontmatter correctness. It commits each write as a discrete git commit.
- **The anchor agent** is a passive host. Its only role is to provide a MemFS that the cloud can clone, so the bundle is reachable from any host with the mod. The anchor is not a curator, not a chat surface, not a writer.
- **The OKF bundle** is just a directory. No database, no service. The format is the API.

### 3.2 The anchor agent

A dedicated Letta Code agent (created by the mod's init flow) whose MemFS hosts the canonical bundle. The agent's role is purely custodial:

- The mod creates it with minimal tags: `okf-anchor`, `git-memory-enabled`.
- The mod overwrites its `persona` block with a one-line note: "This agent hosts the OKF bundle. It does not respond to user prompts." (Optional. If persona is left alone, the agent may try to chat, which is harmless but noisy.)
- The mod never calls `agents.messages.create` on the anchor.
- The agent's MemFS is cloned to the local host at `~/.letta/agents/<anchor-id>/memory/okf/` via the cloud git endpoint, the same way TeamTalk materializes a steward.

Why an anchor and not a bare directory? Two reasons:

1. **Cross-host reachability.** A bare directory at `~/.letta/okf/` is local-only. An agent's MemFS is cloud-backed, so the bundle is reachable from any host with the mod.
2. **Visibility and control.** The user can inspect the bundle in `chat.letta.com` (read-only MemFS browser) and manage the agent with the same UI they use for other agents.

### 3.3 The bundle layout

```
~/.letta/agents/<anchor-id>/memory/okf/
├── index.md                  # bundle root index, okf_version frontmatter
├── log.md                    # chronological write history
├── rules/
│   ├── global/               # always-on rules injected every turn
│   │   ├── reply-to-pr-comments-individually.md
│   │   └── use-harness-secrets-over-env-vars.md
│   └── triggered/            # rules loaded on demand by trigger match
│       └── clean-up-after-pr-merge.md
├── decisions/                # architectural decisions (ADRs as concepts)
├── playbooks/                # multi-step procedures
├── references/               # pointers to external systems/docs
└── people/                   # human team members and their context
```

All `.md` files (except `index.md` and `log.md`) MUST have a frontmatter block with at least `type`. Recommended fields per OKF v0.1 §4.1: `title`, `description`, `tags`, `timestamp`, `resource`.

A bundle-root `index.md` MAY declare `okf_version: "0.1"` (the only frontmatter permitted in a root index, per OKF v0.1 §11).

We define five top-level concept types in v1:

- `Rule` — a behavioral guideline. May be always-on (`rules/global/`) or triggered (`rules/triggered/`).
- `Decision` — an architectural decision (lightweight ADR). Always-on by default.
- `Playbook` — a multi-step procedure. Loaded on demand.
- `Reference` — a pointer to an external system, document, or dataset.
- `Person` — a human team member with context (contact, role, focus areas).

These are conventions, not a schema. The mod's `okf_propose` accepts any non-empty `type` and the bundle tolerates unknown types per the OKF spec.

### 3.4 The dreaming → rule promotion loop

"Reflection" in Letta Code has two distinct surfaces:

1. **A reflection subagent** spawned via the `Agent`/`Task` tool. The subagent reads recent conversation history and returns an insight.
2. **The `order: 1` dreaming indicator** — the visual status above the input while a background agent is running. This is purely a status row.

The promotion loop hooks into (1), not (2). The flow:

1. The user-agent receives a task. At a natural inflection point (e.g., end of work, before compaction, after a milestone), the user-agent spawns a reflection subagent with the recent N turns of history.
2. The reflection subagent returns a structured payload: `{ insights: [{ kind, title, body, ... }, ...] }`. The subagent's contract is well-defined; see §6.3.
3. For each insight worth promoting, the user-agent calls `okf_propose` with the structured fields.
4. The mod validates, writes, appends to `log.md`, and commits. Returns the new concept ID.
5. On the next `turn_start`, new always-on rules inject into the user-agent's context. Triggered rules appear in the trigger catalog and can be loaded via `okf_load_rule`.

The `okf_propose` call is the *only* path to write. The reflection subagent never writes directly; it returns structured data that the user-agent translates into a proposal.

## 4. Mod surface

### 4.1 Capabilities

Declared in the package manifest:

- `tools` — for `okf_search`, `okf_load_rule`, `okf_propose`, `okf_audit`.
- `commands` — for `/okf init`, `/okf status`, `/okf search`, `/okf propose`, `/okf audit`.
- `events.lifecycle` — for `init` and `materialize` at session start.
- `events.turns` — for `turn_start` rule injection.

We register `events.turns` for rule injection. This makes the mod a *listener mod*, which means we lose `letta.client.agents.*` access during turn hooks. The workaround, copied from the same design pivot TeamTalk is planning: rule injection happens by reading the local bundle at `turn_start` time, and the mod's `lifecycle.start` handler does all the SDK work (anchor materialization) before the first turn. The mod's `okf_propose` tool itself does the SDK-equivalent file writes via `node:fs` (process-level, not tool-mediated), which is not affected by the listener-mod classification.

### 4.2 Tools

**`okf_search(query: string, max_results?: number)`** — keyword search across the bundle. Walks `*.md` files, skips `index.md`/`log.md`, parses frontmatter for `title`/`description`/`tags`, scores against the body. Returns:

```ts
{
  results: Array<{
    conceptId: string;      // bundle-relative path minus .md
    type: string;
    title: string;
    description: string;
    tags: string[];
    score: number;
    snippet: string;        // first ~200 chars of body around the first match
  }>;
  scanned: number;          // total concepts scanned
}
```

**`okf_load_rule(trigger: string)`** — loads a triggered rule's body into a per-session cache. Resets a TTL (default 30 turns). On `turn_start` and on any `okf_search` hit, the TTL for matching rules is reset. After TTL expires, the rule is evicted from the in-memory cache and must be re-loaded.

**`okf_propose(concept: ProposalInput)`** — the write path. Validates, writes, commits, logs.

```ts
interface ProposalInput {
  type: string;             // "Rule" | "Decision" | "Playbook" | "Reference" | "Person" | custom
  title: string;
  description?: string;
  body: string;             // markdown
  tags?: string[];
  path?: string;            // explicit bundle-relative path; default derived from title
  trigger?: string;         // for triggered rules; null/absent for always-on
  triggerDescription?: string;
  ttl?: number;             // for triggered rules
}
```

Validation pipeline (each step is fatal on failure):

1. `path` (explicit or derived) is under the bundle root and not reserved.
2. `path` does not already exist (no in-place updates in v1).
3. `body` is non-empty.
4. `type` is non-empty.
5. No secret patterns in any field (re-use the v1 pattern set from TeamTalk's `secrets.ts`).
6. Frontmatter renders as valid YAML (round-trip via `js-yaml` or hand-rolled serializer).

On success:

1. Write the concept file with rendered frontmatter.
2. Append an entry to `log.md` under today's date.
3. If the proposal is a `Rule`, re-render the always-on section of `system/rules.md`.
4. `git add <touched files only> && git commit -m "okf: add <type> <title>"`.
5. Return `{ conceptId, path, commit }`.

**`okf_audit()`** — corpus health check. Walks the bundle and returns:

```ts
{
  totalConcepts: number;
  byType: Record<string, number>;
  byDirectory: Record<string, number>;
  orphanedReferences: string[];   // bundle-relative links to non-existent concepts
  missingFrontmatter: string[];   // paths without parseable frontmatter
  secretScanFindings: string[];   // concepts matching SECRET_PATTERNS
  oldestByTimestamp: Array<{ conceptId, timestamp }>;
}
```

This is the human-inspection tool. It surfaces drift without enforcing it.

### 4.3 Commands

- `/okf init [--create-anchor] [--anchor-agent <id>]` — create a new anchor agent (default) or bind to an existing one. Materialize the local clone. Idempotent: re-running with the same anchor is a no-op.
- `/okf status` — runtime mode, anchor ID, bundle path, concept count, last commit hash, last commit timestamp.
- `/okf search <query>` — convenience wrapper around `okf_search`, with formatted output.
- `/okf propose` — interactive flow: prompt for `type`, `title`, `description`, `body`, `tags`, `path`, `trigger?`, then call `okf_propose`. Optional `--from-file <path>` to read the body from a file.
- `/okf audit` — convenience wrapper around `okf_audit`, with formatted output.
- `/okf reseed` — refresh the local clone from the cloud (re-clone or `git pull --ff-only`).

### 4.4 Events

**`lifecycle.start`** — on session start:

1. Read `~/.letta/mods/okf-store.state.json` to get the anchor agent ID.
2. If absent, log "okf-store not initialized; run `/okf init`" and exit.
3. Materialize the bundle: if `~/.letta/agents/<anchor-id>/memory/okf/` exists and is a git clone, run `git pull --ff-only`. Otherwise, `git clone ${LETTA_BASE_URL}/v1/git/<anchor-id>/state.git`.
4. Cache the bundle root path in memory for the session.

**`turn_start`** — on every turn:

1. Read the always-on section of the bundle (files in `rules/global/` with `type: Rule`).
2. Read the triggered-rule catalog (titles + descriptions of all triggered rules).
3. Read the in-memory TTL cache and inline the bodies of any unexpired triggered rules.
4. Return `{ input: [{ role: "system", content: <rendered prefix> }] }` to prepend as a transient prefix.

## 5. Data flow examples

### 5.1 Init (first time)

```
/okf init
  → letta.client.agents.create({ name: "okf-anchor", tags: [...] })
  → agent ID returned
  → letta.client.agents.blocks.update("persona", { agent_id, value: <minimal persona> })
  → state.json: { anchorAgentId: <id>, bundlePath: null, createdAt: <iso> }
  → background: materialize the clone at ~/.letta/agents/<id>/memory/okf/
  → if clone empty: seed with assets/team/{index.md, log.md, rules/global/*.md, ...}
  → commit the seed
  → state.json: { anchorAgentId: <id>, bundlePath: <path>, lastSyncAt: <iso> }
  → return: "Anchor agent created. Bundle ready at <path>."
```

### 5.2 Promoting a dream

```
[user-agent receives task, completes it]
  → spawns reflection subagent with the last 10 turns
  → subagent returns: { insights: [{
      kind: "rule",
      title: "Reply to PR review comments individually",
      body: "When the GitHub bot posts review comments, reply to each one in its own thread...",
      trigger: "reviewing-pr-comments"
    }] }
  → user-agent: okf_propose({
      type: "Rule",
      title: "Reply to PR review comments individually",
      body: "...",
      trigger: "reviewing-pr-comments"
    })
  → mod validates, writes okf/rules/triggered/reply-to-pr-review-comments-individually.md
  → mod appends to okf/log.md: "## 2026-07-16\n* **Creation**: Rule 'Reply to PR review comments individually' (triggered: reviewing-pr-comments)"
  → mod re-renders okf/system/rules.md (no change to always-on, but adds the rule to the trigger catalog)
  → mod commits
  → returns { conceptId: "rules/triggered/reply-to-pr-review-comments-individually" }
  → on next turn_start, the trigger catalog includes the new rule
  → when the user-agent later encounters a PR review comment, okf_search returns the rule
  → user-agent calls okf_load_rule("reviewing-pr-comments") to load the body
```

### 5.3 Cross-host read

```
[user opens new conversation on a different host]
  → lifecycle.start: read state.json, find anchor ID
  → git clone ${LETTA_BASE_URL}/v1/git/<anchor-id>/state.git → ~/.letta/agents/<id>/memory/okf/
  → turn_start: read rules, prepend as transient prefix
  → user-agent immediately has access to the same global rules
```

## 6. Critical design decisions

### 6.1 Why no steward agent

A steward agent introduces three problems we don't need:

1. **A second writer surface.** The steward would need write tools to be a real curator. We avoid that entirely by making the mod the only writer.
2. **A conversational back-channel** that is rarely used. The corpus is not a chat surface. If a user wants to ask "is there a rule about X?", they run `/okf search X`.
3. **A binding state machine** (`stewardAgentId` vs `bundlePath` vs `lastSyncAt`). The anchor agent is just a host; the mod doesn't talk to it conversationally.

The trade-off: a human can no longer chat with the corpus. We accept that. If we want a curator later, it can be a separate `okf-curator` package that *reads* the corpus and answers questions — not writes to it.

### 6.2 Why an anchor agent and not a bare directory

A bare directory at `~/.letta/okf/` is local-only. To make the bundle reachable from multiple machines, we need cloud-side storage. Letta Code agents provide this via their MemFS git endpoint. Using an anchor agent is the lightest way to get that storage — no separate service to maintain.

Alternatives considered:

- **GitHub repo.** Works, but introduces a third-party dependency. A user on a private Letta Code install doesn't necessarily want their corpus on GitHub.
- **S3 / GCS.** Works, but requires credentials and lifecycle management. Overkill for a directory of markdown.
- **Bare directory + manual sync.** Simple but loses the cross-host read flow.

The anchor agent is the path of least resistance.

### 6.3 The reflection subagent contract

The reflection subagent's role is narrow: read recent conversation history, return structured insights. We don't dictate how it's spawned (the user-agent decides based on the model) but we do define the output shape:

```ts
interface DreamOutput {
  insights: Array<{
    kind: "rule" | "decision" | "playbook" | "reference" | "person";
    title: string;
    description: string;
    body: string;
    trigger?: string;          // for kind: "rule"
    tags?: string[];
  }>;
}

interface DreamOutput {
  // Either: a list of insights
  insights: [...];
  // Or: a statement that nothing is worth promoting
  noInsights: true;
  reason?: string;
}
```

The user-agent (not the mod) is responsible for translating a `DreamOutput` into one or more `okf_propose` calls. The mod doesn't know about reflection subagents.

### 6.4 Path conventions

Concept paths are derived deterministically from the title:

1. Lowercase the title.
2. Replace any non-`[a-z0-9-]` character with `-`.
3. Collapse multiple `-` to one.
4. Trim leading/trailing `-`.
5. Prepend the directory implied by `type` (`rules/global/` for always-on rules, `rules/triggered/` for triggered rules, etc.).

A user can override the path explicitly via the `path` field in `okf_propose`. If the override path already exists, the call fails — no in-place updates in v1.

### 6.5 Secret scanning

The mod maintains a list of secret patterns (re-using the proven set from prior work):

- AWS access keys (`AKIA...`)
- GitHub tokens (`ghp_...`, `gho_...`, `ghs_...`)
- Slack tokens (`xox[baprs]-...`)
- PEM private keys (`-----BEGIN ... PRIVATE KEY-----`)
- Unquoted `KEY=VALUE` lines that look like environment variables

A `containsSecret(text)` function checks every field of a proposal (title, description, body, tags, path) and fails the proposal on any match. This is a defensive check, not a guarantee — humans can still paste secrets in formats the patterns don't recognize.

## 7. Implementation plan

### 7.1 Scaffolding (this PR)

- `packages/okf-store/package.json` — manifest with capabilities, engine floor, scripts.
- `packages/okf-store/mods/index.ts` — single-file mod (per the creating-mods skill default).
- `packages/okf-store/mods/lib/frontmatter.ts` — minimal YAML frontmatter parser/serializer.
- `packages/okf-store/mods/lib/paths.ts` — `slugify`, `isInside`, `relativePosix`, `formatDisplayPath`.
- `packages/okf-store/mods/lib/secrets.ts` — `containsSecret`, `SECRET_PATTERNS`.
- `packages/okf-store/mods/lib/okf.ts` — `walkBundle`, `keywordSearch`, `countConcepts`, `validateProposal`, `renderAlwaysOnSection`, `renderTriggerCatalogSection`, `renderRulesFile`, `appendLogEntry`.
- `packages/okf-store/mods/lib/materialize.ts` — `materializeAnchor(agentId)`, `refreshAnchor(agentId)`.
- `packages/okf-store/mods/lib/state.ts` — `readState`, `writeState`, type definitions.
- `packages/okf-store/tests/*.test.ts` — vitest specs for every pure helper.
- `packages/okf-store/assets/okf/{index.md, log.md, rules/global/*.md, rules/triggered/*.md}` — seed bundle.
- `packages/okf-store/README.md`, `MOD.md`, `GETTING_STARTED.md`.

### 7.2 Phased rollout

**v0.1 — Core store** (this PR)
- `okf_search`, `okf_propose`, `okf_audit` tools.
- `/okf init`, `/okf status`, `/okf search`, `/okf propose`, `/okf audit` commands.
- `lifecycle.start` materialization.
- Seed bundle with 3 starter rules.
- Vitest setup, CI wiring (mirror the pattern from prior work).

**v0.2 — Rule injection**
- `turn_start` handler that prepends always-on rules and a trigger catalog.
- `okf_load_rule` tool with TTL cache.
- `rules/triggered/` support in `okf_propose`.

**v0.3 — Dreaming loop**
- Documented reflection-subagent contract.
- Optional: an `okf_dream_capture` tool that takes a `DreamOutput` and fans out `okf_propose` calls.
- `/okf reflect` command that spawns the reflection subagent and proposes the results.

**v0.4+ — deferred**
- QMD/hybrid search.
- Corpus audit agent (read-only).
- Multi-corpus support (multiple anchors).
- Cross-corpus references.

### 7.3 Out of scope for v0.1

- Windows CI runner. Add as a one-line change after v0.1 lands and macOS CI is green.
- Semantic search.
- Curator/chat surface.
- Cross-anchor syncing.
- Permission overlays for non-mod writes (we are the only writer, so this is moot).

## 8. Open questions

1. **Bundle root location inside the anchor agent's MemFS.** I've proposed `memory/okf/`. Alternative: `memory/` (the bundle IS the entire MemFS). The first is more compatible with future MemFS additions (e.g., if the anchor agent ever needs a small `system/persona.md`); the second is simpler. Default: `memory/okf/`.

2. **Seed content.** Three starter rules in v0.1 — which three? Candidates: a rule about replying to PR comments individually, a rule about using harness secrets, a rule about cleaning up worktrees after PR merge. Final list should be the kind of rules a real team would have on day one.

3. **Author identity for commits.** The mod's git author. Options: the mod's name (`okf-store`), a fixed human identity (Luis's `kaaloo@gmail.com`), or a per-anchor identity. Default: fixed human identity, since the write is conceptually a human-mediated action (the user-agent proposed it on behalf of a human's review).

4. **Reflection subagent contract owner.** Should the contract live in this mod's docs, in a separate skill, or in a sibling package? I lean toward a sibling skill (`.letta/skills/dreaming-protocol/`) so the contract is usable outside the mod.

5. **Cross-host collision.** If two hosts both try to write at the same time, the second `git push` will fail (non-fast-forward). The mod's `okf_propose` runs on the local clone and pushes via the anchor's git endpoint. We need a pull-before-write step. The default flow: every `lifecycle.start` does `git pull --ff-only`. If the local clone is ahead (uncommitted write from a previous session), the mod needs to either rebase or fail. Decision needed: how aggressive to be about resolving the divergence.

## 9. References

- OKF v0.1 spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
- Letta Mods docs: https://www.letta.com/blog/introducing-mods/
- Letta Code mod skill: `~/.letta/skills/creating-mods/SKILL.md`
- Letta API git endpoint: `GET /v1/git/<agent-id>/state.git` (smart-HTTP)
