// context-bump: raises the context window and max output tokens for hosted
// Letta model conversations. Automatic on conversation open (with turn_start
// as a fallback surface); no slash command. Targets live in the squad-mods
// shared memory repository at context-bump/config.json, with built-in
// defaults as a fallback. Raise-only: it never lowers a higher manual pin.

import type {
  LettaModContext,
  ModConversationOpenEvent,
  ModEventHandlerContext,
  ModTurnStartEvent,
} from "./types.ts";
import { defaultConfig, resolveTarget } from "./lib/config.ts";
import type { BumpConfig } from "./lib/config.ts";
import { ensureMount, loadConfig } from "./lib/ledger.ts";
import type { MountInfo } from "./lib/ledger.ts";
import { buildRaisePatch } from "./lib/limits.ts";
import type { CurrentLimits } from "./lib/limits.ts";
import { writeBumpState } from "./lib/state.ts";

interface Runtime {
  initialized: boolean;
  initPromise: Promise<void> | null;
  agentId: string | null;
  mount: MountInfo;
  config: BumpConfig;
  source: "shared" | "defaults";
  /** Conversation ids already applied in this process lifetime. */
  appliedFor: Set<string>;
  agentRaised: boolean;
  mountWarned: boolean;
}

export default function activate(letta: LettaModContext): () => void {
  const disposers: Array<() => void> = [];

  // Observability: proves the mod activated on this surface. Shows up in
  // ~/.letta/mods/diagnostics/latest.json with `letta mods diagnostics`.
  letta.diagnostics?.report({ message: "context-bump: mod activated", severity: "warning" });

  const rt: Runtime = {
    initialized: false,
    initPromise: null,
    agentId: null,
    mount: { path: "squad-mods", available: false, clonedByMod: false },
    config: defaultConfig(),
    source: "defaults",
    appliedFor: new Set(),
    agentRaised: false,
    mountWarned: false,
  };

  async function initialize(ctx: ModEventHandlerContext): Promise<void> {
    if (rt.initialized) return;
    if (!rt.initPromise) {
      rt.initPromise = (async () => {
        const agentId = ctx.agent?.id ?? null;
        const memoryDir = ctx.memfs?.memoryDir ?? process.env.MEMORY_DIR ?? null;
        rt.agentId = agentId;
        rt.mount = await ensureMount(
          memoryDir,
          agentId,
          process.env.LETTA_BASE_URL ?? null,
          process.env.LETTA_API_KEY ?? null,
        );
        if (!rt.mount.available && !rt.mountWarned) {
          rt.mountWarned = true;
          letta.diagnostics?.report({
            message: "context-bump: squad-mods mount unavailable; running on built-in defaults",
            severity: "warning",
          });
        }
        const loaded = await loadConfig(rt.mount, process.env.LETTA_API_KEY ?? null);
        rt.config = loaded.config;
        rt.source = loaded.source;
      })();
    }
    await rt.initPromise;
    rt.initialized = true;
  }

  async function readCurrentLimits(
    conversationId: string | null,
    agentId: string | null,
  ): Promise<{ conversation: CurrentLimits; agent: CurrentLimits } | null> {
    const client = letta.client;
    if (!client || !conversationId || !agentId) return null;
    const [conversation, agent] = await Promise.all([
      client.conversations.retrieve(conversationId).catch(() => null),
      client.agents.retrieve(agentId).catch(() => null),
    ]);
    const conversationSettings = (conversation?.model_settings ?? null) as Record<string, unknown> | null;
    const agentSettings = (agent?.model_settings ?? null) as Record<string, unknown> | null;
    return {
      conversation: {
        contextWindow:
          typeof conversation?.context_window_limit === "number" ? conversation.context_window_limit : null,
        maxOutputTokens:
          typeof conversationSettings?.max_output_tokens === "number"
            ? conversationSettings.max_output_tokens
            : null,
      },
      agent: {
        contextWindow: typeof agent?.context_window_limit === "number" ? agent.context_window_limit : null,
        maxOutputTokens:
          typeof agentSettings?.max_output_tokens === "number" ? agentSettings.max_output_tokens : null,
      },
    };
  }

  async function raiseLimits(ctx: ModEventHandlerContext, reason: string): Promise<void> {
    const conversationId = ctx.conversation?.id ?? null;
    const agentId = ctx.agent?.id ?? null;
    if (!conversationId || !agentId) return;
    const target = resolveTarget(rt.config, ctx.model?.id ?? null, agentId);
    const current = await readCurrentLimits(conversationId, agentId);
    if (!current) return;

    const conversationPatch = buildRaisePatch(current.conversation, target);
    if (conversationPatch) {
      await letta.client?.conversations.update(conversationId, conversationPatch).catch(() => {});
      letta.diagnostics?.report({ message: `context-bump: raised conversation (${reason})`, severity: "warning" });
    }

    // Record the outcome for the statusline's override marker. Always write so
    // the marker reflects the current truth (and clears when nothing was raised).
    const patchSettings = conversationPatch?.model_settings as { max_output_tokens?: number } | undefined;
    writeBumpState(agentId, conversationId, {
      bumped: conversationPatch !== null,
      contextWindow:
        typeof conversationPatch?.context_window_limit === "number"
          ? conversationPatch.context_window_limit
          : current.conversation.contextWindow,
      maxOutputTokens: patchSettings?.max_output_tokens ?? current.conversation.maxOutputTokens,
      at: new Date().toISOString(),
    });

    if (!rt.agentRaised) {
      const agentPatch = buildRaisePatch(current.agent, target);
      if (agentPatch) {
        await letta.client?.agents.update(agentId, agentPatch).catch(() => {});
        letta.diagnostics?.report({ message: "context-bump: raised agent default", severity: "warning" });
      }
      rt.agentRaised = true;
    }
  }

  // Run the bump in the background. The handlers are invoked during
  // conversation open / turn start, and awaiting them would block the host UI
  // on git (mount sync) and network I/O. Fire-and-forget keeps the UI
  // responsive; errors are swallowed inside initialize/raiseLimits.
  if (letta.capabilities?.events?.lifecycle) {
    disposers.push(
      letta.events.on<ModConversationOpenEvent>("conversation_open", (event, ctx) => {
        const cid = event.conversationId ?? ctx.conversation?.id ?? "unknown";
        rt.appliedFor.add(cid);
        void initialize(ctx)
          .then(() => raiseLimits(ctx, "conversation-open"))
          .catch(() => {});
      }),
    );
  }

  if (letta.capabilities?.events?.turns) {
    disposers.push(
      letta.events.on<ModTurnStartEvent>("turn_start", (event, ctx) => {
        const cid = event.conversationId ?? ctx.conversation?.id ?? "unknown";
        // Surfaces without lifecycle events (headless runs, Desktop listeners)
        // may never fire conversation_open, so enforce on the first turn of
        // each conversation as well.
        if (rt.appliedFor.has(cid)) return;
        rt.appliedFor.add(cid);
        void initialize(ctx)
          .then(() => raiseLimits(ctx, "turn-start"))
          .catch(() => {});
      }),
    );
  }

  // No panel row: the statusline already renders the live context bar, and the
  // bump is surfaced there as a compact override marker read from the state
  // cache written in raiseLimits.

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
