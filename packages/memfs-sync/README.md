# @kaaloo/memfs-sync

Two-way sync between a Letta Code MemFS checkout and a shared GitHub memory repository, so several agents can work from the same memory without overwriting each other.

- **Before each turn**, it fetches the shared branch and fast-forwards a clean checkout, so the agent starts from the latest memory.
- **After a local memory commit**, it does the following:
  1. rebases the commit onto the shared branch and re-signs it with your signing key;
  2. optionally regenerates the `MEMORY.md` indexes;
  3. pushes.
- **It never force-pushes.** If a rebase conflicts, it aborts, leaves both sides untouched and tells you.

Sync is opt-in per memory checkout. If a checkout has no `memfsSync.enabled`, the mod does nothing.

## Installation

```bash
cd packages/memfs-sync
npm install
letta install .
```

Then reload mods inside Letta Code with `/reload`.

## Setup

Run these commands inside the agent's memory checkout (`$MEMORY_DIR`):

```bash
cd "$MEMORY_DIR"
git remote add origin git@github.com:<owner>/<memory-repo>.git
git config memfsSync.enabled true

# Optional settings (defaults shown in comments)
git config memfsSync.remote origin              # remote name
git config memfsSync.branch main                # shared branch
git config memfsSync.sign true                  # re-sign rebased commits
git config memfsSync.signingKey ~/.ssh/id_ed25519.pub   # key used for sync rewrites
git config memfsSync.committerName "Your Name"
git config memfsSync.committerEmail you@example.com     # must match a verified GitHub email
git config memfsSync.indexCommand 'python3 /path/to/memfs.py --dir . index'
git config memfsSync.maxAttempts 3              # fetch/rebase/push retries when the remote moves
```

Letta Code's own agent commits are unsigned and use the agent's address. With `sign` on, the rebase rewrites every unpushed commit and keeps its author, but sets the committer from `committerName`/`committerEmail` and signs it with `signingKey`. GitHub then shows the commits as verified, which repositories that require signed commits demand.

Leave `letta.memoryRepository.url` unset on checkouts this mod manages. That built-in hook pushes unsigned commits in the background, which races with the mod.

## Usage

The mod runs on its own. You can also call it directly:

- `/memfs-sync` runs a sync now and prints the outcome.
- `/memfs-sync status` shows the configuration and the last outcome.

Anything that is not a no-op is shown as a transcript notification in the TUI. Every run, including skips, is appended to `.git/memfs-sync.log`.

### When it does not sync

The mod skips a run, and says why, when:

- tracked files have uncommitted changes;
- the checkout is not on the configured branch (for example a reflection worktree branch);
- a rebase, merge or cherry-pick is in progress.

## Development

```bash
npm install
npm run check    # build + typecheck + tests
npm run verify   # verify:bundle + typecheck + tests
```

The tests run real `git` against a temporary bare remote and generate a throwaway SSH signing key, so `git` and `ssh-keygen` must be on `PATH`.
