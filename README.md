# kaaloo/agent-mods

Monorepo for trusted [Letta Code](https://github.com/letta-ai/letta-code) mods maintained by kaaloo, plus the shared CI and security tooling used to publish them.

## Packages

| Package | Description |
| --- | --- |
| [`@kaaloo/okf`](packages/okf) | OKF trust-signal enforcement for agent memory in MemFS. Validates provenance, verification, freshness, and lifecycle on memory writes via permission overlays. |
| [`@kaaloo/amazing-grace`](packages/amazing-grace) | Graceful model degradation. Steps an agent down a usage-plan model ladder on provider failures (quota, invalid key, images on text-only rungs) and back up after recovery, logging every switch to shared memory. |

New packages land under `packages/*` with their own `package.json`, `README.md`, and (where applicable) `MOD.md`.

## Installation

Each package is a Letta mod and is installed individually from its directory. To build and verify a package locally you also need Bun 1.4.4 installed (the package build/verify scripts invoke `bun build`); the workspace-root `npm install` is enough for the secret- and dependency-scanning hooks alone. npm 12.2.1 or later is required for the seven-day release-age policy in each `.npmrc`. The three existing npm lockfiles are deliberately retained instead of migrating the repo to pnpm.

```bash
git clone https://github.com/kaaloo/agent-mods.git
cd agent-mods

# Install the workspace root (currently only used for dev tooling: gitleaks, cve-lite, husky)
npm install

# Install and enable a mod (example: okf)
cd packages/okf
npm install
letta install .
```

Then reload mods inside Letta Code with `/reload`.

Alternatively, install the whole collection from this repository over the git
channel. Git sources are `owner/repo` only, so the repo-root
`package.json#letta` manifest is what a git install loads: it lists every
package's bundled mod (entries point into `packages/*`) and declares the union
of their capabilities and the highest engine floor. Keep the root manifest in
sync when adding or changing a package.

```bash
letta install git:github.com/kaaloo/agent-mods

# Or install into one agent's MemFS so the mods travel with that agent:
letta install git:github.com/kaaloo/agent-mods --agent <agent-id>
```

Pick one channel per environment. A mod installed both from its package
directory and from the git channel registers twice (the two installs have
different source paths), so its event handlers run twice. Use the git channel
for agents/environments and the per-package channel for development.

### Removing Previously Installed Mods

Installing an updated revision does not uninstall mods that were already
installed. Environments that installed this repository through the git channel
before the `@kaaloo/flows` package was removed still have the old flows mod
active (its `/flow` command, `flow_*` tools, and event handlers keep running).
To clean up an existing install, remove the obsolete entry with
`letta mods remove` or delete the old installed mod directory under
`~/.letta/mods/`, then restart the Letta Code session so the change takes
effect.

See each package's README for package-specific usage.

## Repository layout

```
.
├── packages/
│   ├── okf/              # @kaaloo/okf mod (TypeScript source, bundled JS, tests)
│   └── amazing-grace/    # @kaaloo/amazing-grace mod (TypeScript source, bundled JS, tests)
├── docs/                 # Design notes and implementation plans
├── .github/
│   ├── prompts/          # System prompts used by the CI agent
│   ├── scripts/          # Helpers invoked from workflows
│   └── workflows/        # GitHub Actions workflows
├── .husky/               # Local git hooks (pre-commit, pre-push)
├── .gitleaks.toml        # Allowlisted secrets for the secret scanner
└── package.json          # Workspace root manifest (dev tooling + git-install letta manifest)
```

## Security tooling

This repo ships two layers of supply-chain guardrails at the local git-hook boundary. The secret-scanning layer is also enforced server-side; the dependency-scanning layer is local-only for now.

### Secret scanning — gitleaks

- **Local** — `.husky/pre-commit` runs `gitleaks protect --staged --redact` against every commit.
- **Server-side** — `.github/workflows/gitleaks.yml` rescans pushes and pull requests with full git history. This is defense-in-depth against `git commit --no-verify` bypasses; it scans repository content and commit history but does **not** inspect PR title or PR body text.
- **Configuration** — `.gitleaks.toml` at the repo root is the single source of truth for allowlist entries. Prefer a real allowlist entry over `git commit --no-verify`. The CI workflow verifies the Gitleaks binary's SHA-256 and scans the repository's Git history; it does not inspect PR title or body text. GitHub secret scanning and push protection are enabled separately.

Useful scripts at the workspace root:

```bash
# Scan the entire working tree (baseline / sanity check)
npm run security:scan:secrets

# Scan only the staged diff (matches the pre-commit hook)
npm run security:scan:secrets:staged
```

### Dependency scanning — cve-lite

- **Local** — `.husky/pre-push` scans each package under `packages/` with `cve-lite --fail-on high` before every push. It is wired to `pre-push` (not `pre-commit`) because cve-lite analyzes the whole lockfile rather than staged filenames. OSV-Scanner covers the same manifests in CI; the local-only cve-lite check does not replace that gate.
- **Configuration** — lockfile pinning and `cve-lite-cli` version are declared in the root `package.json` and each package's `package-lock.json`. The package paths are listed in `.husky/pre-push` and the root `security:scan:js` script; adding a new package means updating both. The only native build approval is `better-sqlite3`, used by cve-lite's advisory database.

Useful scripts at the workspace root:

```bash
# Scan all package workspaces for high-severity CVEs
npm run security:scan:js
```

### Bypassing hooks

Hooks must not be bypassed without explicit approval from Luis. Prefer adding a narrowly scoped allowlist entry to `.gitleaks.toml` over bypassing for secret scans.

## Continuous integration

- `.github/workflows/gitleaks.yml` — full-history secret scan on push and pull request.
- `.github/workflows/osv-scanner.yml` — PR differential vulnerability scan plus scheduled and main-branch reports to Code Scanning.
- `.github/workflows/ci.yml` — installs the root tooling and each package, runs Biome, then verifies the bundle, typechecks, and tests both packages. Smoke tests import each committed bundle and exercise activation, OKF permission decisions, and Amazing Grace registration.
- `.github/workflows/release-please.yml` — maintains release PRs for both publishable packages with a dedicated Actions token (`RELEASE_PLEASE_TOKEN`), then SSH-signs the generated commit with `GIT_SIGNING_KEY`. The PAT makes the PRs trigger the required checks; the SSH signature satisfies `required_signatures`. `versioning: always-bump-minor` keeps every pre-1.0 release on `0.x.0`, including fixes. To approve 1.0, change the strategy to `default` in the same commit that contains `Release-As: 1.0.0`; that override is evaluated by the default strategy.
- `.github/dependabot.yml` — covers all three npm manifests and GitHub Actions with a seven-day cooldown. Each `.npmrc` also sets `min-release-age=7`; Dependabot security updates are not delayed by its cooldown.
- Biome checks source and configuration only; generated `*.bundled.mjs` files are covered by `verify:bundle`, not rewritten by the formatter.
- Code review is handled via Codex.

### Release automation credentials

Two existing repository secrets cover the different parts of release automation:

- `RELEASE_PLEASE_TOKEN` — creates and updates the release PR and branch. A PAT is required here because pull requests created or updated with the default `GITHUB_TOKEN` leave their required checks waiting for manual approval.
- `GIT_SIGNING_KEY` — signs the generated release commit. The committer is `Luis Arias <luis.arias@numerique.gouv.fr>`, whose email and SSH signing key are registered with GitHub. The key may be stored as raw PEM or base64-encoded PEM.

The PAT alone is not enough: its API-generated commits have no signature and are rejected by `required_signatures`. After release-please updates the branch, the workflow checks that the branch head is exactly one commit on top of the `main` commit that triggered the run, amends that commit with the SSH signature, verifies it locally, and pushes it with `--force-with-lease`. It never rewrites `main` or an unexpected release-branch history, and it removes the private key when the step exits.

`release-please-config.json` sets `"always-update": true`. By default release-please leaves an existing release branch unchanged when the generated notes have not changed. Forcing the update rebuilds the branch from the current `main` on every run, giving the signing step a fresh commit with the expected parent. Combined with the `force: true` branch update release-please applies by default, the branch is reset onto `main` rather than stacked on the previous release commit.

## Per-package verification

Each mod defines its own quality gate. For `@kaaloo/okf`:

```bash
cd packages/okf
npm run check    # build + typecheck + tests
npm run verify   # verify:bundle + typecheck + tests (fails if the bundled JS drifts from source)
```

## License

[MIT](LICENSE.md). See `package.json` and individual package manifests.
