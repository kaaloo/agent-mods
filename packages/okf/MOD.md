# MOD.md — @kaaloo/okf

A Letta Code mod that enforces [OKF](https://cloud.google.com/blog/products/data-analytics/okf-v0-2-adds-trust-signals) trust signals on agent memory writes in MemFS.

## What it does

OKF v0.2 adds five families of trust signal to YAML frontmatter: provenance, verification, freshness, lifecycle, and attestation. This mod enforces them through two harness mechanisms:

1. **Permission overlay** (`letta.permissions`): gates memory writes to OKF concepts, blocking writes with structural errors (invalid status, broken verification entries, malformed sources).
2. **`tool_end` event handler**: observes successful writes and logs when provenance (`generated`) is missing, nudging agents to self-populate it on the next write.

## Which tools it gates

The mod intercepts MemFS writes through these tools:

- `memory` — Letta's memory block tool
- `Write` — direct file writes to memory paths
- `Edit` — file edits to memory paths

It only activates when the target file (a) lives under a MemFS memory directory and (b) contains YAML frontmatter with a `type:` field (the minimum OKF concept marker).

## Enforced trust signals

| Signal | Field | Enforcement |
|--------|-------|-------------|
| Provenance | `generated: { by, at }` | Warns when missing; validates structure |
| Trust | `verified: [{ by, at }]` | Validates each entry has required fields |
| Freshness | `stale_after` | Warns when past due (unless deprecated) |
| Lifecycle | `status` | Must be `draft`, `stable`, or `deprecated` |
| Attestation | `sources: [{ id, ... }]` | Validates each source has an `id` |

## What it does NOT enforce (yet)

- Cross-file referential integrity (sources pointing to bundle-relative paths)
- Attestation computation (running attesters like `sql_equality.py` before accepting computed values)
- `generated` auto-population in-place (the `tool_end` handler currently only logs; result replacement API depends on future Letta Code releases)

## Architecture

```
packages/okf/
├── mods/
│   ├── index.ts              # Main activation: registers permission overlay + tool_end handler
│   ├── index.bundled.mjs     # Bundled output (committed, used by Letta Code)
│   ├── types.ts              # TypeScript types for the Letta mod runtime + OKF domain
│   ├── lib/
│   │   └── okf.ts            # Frontmatter extraction, validation, provenance generation
│   └── tests/
│       └── okf.test.ts       # Unit tests for OKF validation logic
├── package.json
├── tsconfig.json
└── vitest.config.ts
```
