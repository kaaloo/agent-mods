# kaaloo/agent-mods

Monorepo for trusted [Letta Code](https://github.com/letta-ai/letta-code) mods maintained by kaaloo, plus the shared CI and security tooling used to publish them.

## Packages

| Package | Description |
| --- | --- |
| [`@kaaloo/flows`](packages/flows) | A Letta-native mod for authoring and running multi-agent flows. Describes a task as markdown with YAML frontmatter, fans it out across parallel subagents, and synthesizes the results. |

New packages land under `packages/*` with their own `package.json`, `README.md`, and (where applicable) `MOD.md`.

## Installation

Each package is a Letta mod and is installed individually from its directory. To build and verify a package locally you also need [Bun](https://bun.sh) installed (the package build/verify scripts invoke `bun build`); the workspace-root `npm install` is enough for the secret- and dependency-scanning hooks alone.

```bash
git clone https://github.com/kaaloo/agent-mods.git
cd agent-mods

# Install the workspace root (currently only used for dev tooling: gitleaks, cve-lite, husky)
npm install

# Install and enable the flows mod
cd packages/flows
npm install
letta install .
```

Then reload mods inside Letta Code with `/reload`.

See each package's README for package-specific usage.

## Repository layout

```
.
├── packages/
│   └── flows/          # @kaaloo/flows mod (TypeScript source, bundled JS, tests)
├── docs/               # Design notes and implementation plans
├── .github/
│   ├── prompts/        # System prompts used by the CI agent
│   ├── scripts/        # Helpers invoked from workflows
│   └── workflows/      # GitHub Actions workflows
├── .husky/             # Local git hooks (pre-commit, pre-push)
├── .gitleaks.toml      # Allowlisted secrets for the secret scanner
└── package.json        # Workspace root manifest (dev tooling only)
```

## Security tooling

This repo ships two layers of supply-chain guardrails at the local git-hook boundary. The secret-scanning layer is also enforced server-side; the dependency-scanning layer is local-only for now.

### Secret scanning — gitleaks

- **Local** — `.husky/pre-commit` runs `gitleaks protect --staged --redact` against every commit.
- **Server-side** — `.github/workflows/gitleaks.yml` rescans pushes and pull requests with full git history. This is defense-in-depth against `git commit --no-verify` bypasses; it scans repository content and commit history but does **not** inspect PR title or PR body text.
- **Configuration** — `.gitleaks.toml` at the repo root is the single source of truth for allowlist entries. Prefer a real allowlist entry over `git commit --no-verify`.

Useful scripts at the workspace root:

```bash
# Scan the entire working tree (baseline / sanity check)
npm run security:scan:secrets

# Scan only the staged diff (matches the pre-commit hook)
npm run security:scan:secrets:staged
```

### Dependency scanning — cve-lite

- **Local** — `.husky/pre-push` runs `cve-lite packages/flows --fail-on high` before every push. It is wired to `pre-push` (not `pre-commit`) because cve-lite analyzes the whole lockfile rather than staged filenames. Note that this is a **local-only** check; there is currently no server-side cve-lite job in CI, so `git push --no-verify` will skip it.
- **Configuration** — lockfile pinning and `cve-lite-cli` version are declared in the root `package.json` and `packages/flows/package-lock.json`. The `packages/flows` path is hardcoded today; adding a new package means updating `.husky/pre-push` and the root `security:scan:js` script to cover it.

Useful scripts at the workspace root:

```bash
# Scan the flows workspace for high-severity CVEs
npm run security:scan:js
```

### Bypassing hooks

Hooks can be skipped with `git commit --no-verify` / `git push --no-verify`, but only after the diff has been reviewed by hand. Prefer adding a real allowlist entry to `.gitleaks.toml` over bypassing for secret scans.

## Continuous integration

- `.github/workflows/gitleaks.yml` — secret scan on push and pull request.
- `.github/workflows/letta-code.yml` — runs the persistent Letta Code agent on this repo. Provides:
  - `letta-conversational` — responds when someone @-mentions the agent, applies the `letta-code` label, or replies in a thread the agent has joined.
  - `letta-inline-review` — auto-reviews non-draft pull requests by asking the agent for line-anchored findings and posting them as a PR review. See [`.github/prompts/letta-inline-review.system.md`](.github/prompts/letta-inline-review.system.md) for the review contract.

Both jobs share the agent defined by the `LETTA_REVIEW_AGENT` variable so the agent's long-term memory and the repository's learned conventions stay consistent across surfaces.

## Per-package verification

Each mod defines its own quality gate. For `@kaaloo/flows`:

```bash
cd packages/flows
npm run check    # build + typecheck + tests
npm run verify   # verify:bundle + typecheck + tests (fails if the bundled JS drifts from source)
```

## License

[MIT](LICENSE.md). See `package.json` and individual package manifests.
