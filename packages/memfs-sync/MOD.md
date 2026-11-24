# MOD.md: @kaaloo/memfs-sync

## What it does

This mod keeps a MemFS checkout in step with a shared Git remote. It does three things:

1. **Syncs at turn start, and only there.** A `turn_start` handler runs the sync before the agent's tools run. It fetches `memfsSync.remote`/`memfsSync.branch`. A clean checkout that is strictly behind fast-forwards. A checkout with local commits rebases them onto the remote, re-signs them, runs the optional index command and pushes. A failed sync is reported, and the turn proceeds on the local checkout. The mod never cancels or rewrites a turn.
   - Syncing is deliberately not tied to `tool_end` or `conversation_open`. A sync rebases and resets the checkout, which must not overlap a tool that writes memory. A background trigger after a tool would race with the next tool. Memory committed during a turn therefore reaches the shared repository at the start of the next turn.
2. **Pushes local commits.** Pushing happens inside the same turn-start sync, as described above. It is a private-worktree rebase, index run and push, then a fast-forward of the checkout (`merge --ff-only`) or, after a rebase, a guarded `reset --keep` of the checkout.
3. **Provides a `/memfs-sync [status]` command** for manual runs and inspection.

## Safety properties

- **No force-push**, ever. The push is a plain fast-forward push.
- Rebases and index regeneration never run in the agent's checkout. They run in a private worktree, so a memory write made during a sync can neither land in the index commit nor be reverted.
- Everything is computed from the branch commit pinned before the fetch, never from a later `HEAD`. If a tool switches to a reflection branch or commits during a network wait, that work is not published.
- A checked-out branch moves with `merge --ff-only`, which holds git's locks and refuses unless `HEAD` is still an ancestor. Only a rebased push takes the guarded `reset --keep` fallback, which preserves local edits and refuses to overwrite them. Known limit: `reset --keep` does not compare the branch tip, so a writer outside the mod that commits during that one reset can lose its commit. Keep other writers (for example an editor on the same checkout) out during a turn start.
- A checkout on another branch is never touched; only the shared ref moves, with a compare-and-swap.
- A conflicting or failed rebase is aborted inside the private worktree, so local commits, the working tree and the remote stay as they were.
- Runs are serialized per checkout. Triggers that arrive during a run coalesce into a single follow-up run.
- Git runs through `execFile` without a shell, with `GIT_TERMINAL_PROMPT=0`. Only `memfsSync.indexCommand`, which you configure explicitly, runs through a shell.

## Where it finds the memory checkout

The mod reads `ctx.memfs.memoryDir` from the mod callback context, falling back to `$MEMORY_DIR` or `$LETTA_MEMORY_DIR`. Without a MemFS it does nothing.

## Architecture

```
packages/memfs-sync/
├── mods/
│   ├── index.ts              # Event handlers and /memfs-sync command
│   ├── index.bundled.mjs     # Bundled output (committed, loaded by Letta Code)
│   ├── types.ts              # Typings for the mod runtime surface used here
│   ├── lib/
│   │   ├── git.ts            # execFile wrappers for git and the index command
│   │   └── sync.ts           # Config parsing and the sync state machine (private worktree, CAS)
│   └── tests/
│       ├── sync.test.ts          # Real-git integration tests (bare remote, SSH signing)
│       └── bundle-smoke.test.ts  # Activates the committed bundle
├── package.json
├── tsconfig.json
└── vitest.config.ts
```
