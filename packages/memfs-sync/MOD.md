# MOD.md: @kaaloo/memfs-sync

## What it does

This mod keeps a MemFS checkout in step with a shared Git remote. It does three things:

1. **Pulls at turn start.** A `turn_start` handler (and `conversation_open`, when lifecycle events exist) fetches `memfsSync.remote`/`memfsSync.branch`. It fast-forwards when the checkout is clean and strictly behind. It never cancels or rewrites the turn.
2. **Pushes after commits.** A `tool_end` handler runs after a successful `Bash`/`Shell`/`memory` tool. When `HEAD` has moved since the last sync, it runs a background sync:
   1. `git rebase --force-rebase --gpg-sign <remote tip>`;
   2. the optional index command, whose changes are committed and signed;
   3. `git push <remote> HEAD:refs/heads/<branch>`.

   A rejected push triggers a re-fetch, a rebase and another push, up to `memfsSync.maxAttempts` times.
3. **Provides a `/memfs-sync [status]` command** for manual runs and inspection.

## Safety properties

- **No force-push**, ever. The push is a plain fast-forward push.
- A conflicting or failed rebase is aborted with `git rebase --abort`, so local commits and the working tree stay as they were.
- If the index command fails, only the paths it changed are reverted. Pre-existing untracked files are never touched.
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
│   │   └── sync.ts           # Config parsing and the sync state machine
│   └── tests/
│       ├── sync.test.ts          # Real-git integration tests (bare remote, SSH signing)
│       └── bundle-smoke.test.ts  # Activates the committed bundle
├── package.json
├── tsconfig.json
└── vitest.config.ts
```
