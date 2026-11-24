# MOD.md: @kaaloo/memfs-sync

## What it does

This mod keeps a MemFS checkout in step with a shared Git remote. It does three things:

1. **Pulls at turn start.** A `turn_start` handler (and `conversation_open`, when lifecycle events exist) fetches `memfsSync.remote`/`memfsSync.branch`. It fast-forwards when the checkout is clean and strictly behind. It never cancels or rewrites the turn.
2. **Pushes after commits.** A `tool_end` handler runs after a successful `Bash`/`Shell`/`memory` tool. When `HEAD` has moved since the last sync, it runs a background sync:
   1. pins the configured branch's commit;
   2. in a private detached worktree under the git common dir, runs `git rebase --force-rebase --gpg-sign <remote tip>` and the optional index command, and commits the index command's output, signed;
   3. runs `git push <remote> <pinned result>:refs/heads/<branch>`;
   4. moves the local branch to the pushed commit with a compare-and-swap.

   A rejected push triggers a re-fetch, a rebase and another push, up to `memfsSync.maxAttempts` times.
3. **Provides a `/memfs-sync [status]` command** for manual runs and inspection.

## Safety properties

- **No force-push**, ever. The push is a plain fast-forward push.
- Rebases and index regeneration never run in the agent's checkout. They run in a private worktree, so a memory write made during a sync can neither land in the index commit nor be reverted.
- Everything is computed from the branch commit pinned before the fetch, never from a later `HEAD`. If a tool switches to a reflection branch or commits during a network wait, that work is not published.
- The local branch only moves through a compare-and-swap. A commit made during the push is kept, and the next run rebases it. A checked-out branch's working tree follows through a two-tree `read-tree -m -u`, which keeps unrelated local files and refuses to overwrite conflicting ones.
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
