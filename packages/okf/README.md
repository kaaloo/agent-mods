# @kaaloo/okf

OKF trust-signal enforcement for Letta Code agent memory in MemFS. Validates provenance, verification, freshness, lifecycle, and attestation signals on memory writes via permission overlays.

## Installation

```bash
cd packages/okf-trust
npm install
letta install .
```

Then reload mods inside Letta Code with `/reload`.

## What it enforces

When an agent writes a memory block with OKF-style YAML frontmatter (containing a `type:` field), this mod:

- Blocks writes with structural errors (invalid status, broken `verified` entries, malformed `sources`)
- Warns when `generated` provenance is missing
- Warns when `stale_after` has passed without the concept being deprecated
- Validates that `verified` entries, `sources` entries, and `status` values are well-formed

## Development

```bash
npm install
npm run check    # build + typecheck + tests
npm run verify   # verify:bundle + typecheck + tests
```

## License

MIT
