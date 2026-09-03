// amazing-grace: graceful model degradation for usage-plan model ladders.
//
// Steps an agent down a priority ladder when a provider plan fails (usage
// limit, invalid API key, text-only rung receiving images) and back up after
// recovery. Exception-driven: no token counting. Squad config and the event
// ledger live in the squad-mods shared memory repository.

import type {
  LettaModContext,
  ModCommandContext,
  ModCommandResult,
  ModConversationOpenEvent,
  ModEventHandlerContext,
  ModLlmEndEvent,
  ModToolEndEvent,
  ModTurnEndEvent,
  ModTurnStartEvent,
} from "./types.ts";
import { classifyFailure } from "./lib/classify.ts";
import type { FailureKind } from "./lib/classify.ts";
import { inputHasImages, toolResultLikelyImage } from "./lib/detect.ts";
import { canonicalizeBenchState, canonicalRungHandle, defaultConfig, findRung, handlesMatch, targetRung } from "./lib/ladder.ts";
import type { GraceConfig, LadderRung } from "./lib/ladder.ts";
import { ensureMount, loadContext, saveState } from "./lib/ledger.ts";
import type { MountInfo } from "./lib/ledger.ts";
import { probeRung } from "./lib/probe.ts";
import type { ProbeResult } from "./lib/probe.ts";
import { activeCooldowns, appendEvent, changeKind, expiredCooldowns, markCooldown, markDead, pruneCooldowns, revive } from "./lib/state.ts";
import type { AgentGraceState, GraceEvent } from "./lib/state.ts";

const CONTINUE_MIN_INTERVAL_MS = 120_000;

interface TurnFlags {
  acted: boolean;
  switched: boolean;
}

interface Runtime {
  initialized: boolean;
  initPromise: Promise<void> | null;
  agentId: string | null;
  mount: MountInfo;
  config: GraceConfig;
  state: AgentGraceState;
  source: "shared" | "cache" | "defaults";
  llmEventsAvailable: boolean;
  /** Per-conversation turn bookkeeping; turn events from different
   *  conversations can interleave, so these flags must not be shared. */
  turnFlags: Map<string, TurnFlags>;
  lastContinueAt: Map<string, number>;
  persistQueue: Promise<void>;
  mountWarned: boolean;
  /** Conversation ids already evaluated in this process lifetime. */
  appliedFor: Set<string>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function trim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export default function activate(letta: LettaModContext): () => void {
  const disposers: Array<() => void> = [];

  // Observability: proves the mod activated on this surface. Shows up in
  // ~/.letta/mods/diagnostics/latest.json with `letta mods diagnostics`.
  letta.diagnostics?.report({ message: "amazing-grace: mod activated", severity: "warning" });

  const rt: Runtime = {
    initialized: false,
    initPromise: null,
    agentId: null,
    mount: { path: "squad-mods", available: false, clonedByMod: false },
    config: defaultConfig(),
    state: { agentId: "?", updatedAt: nowIso(), paused: false, pinned: null, cooldowns: {}, dead: [], events: [] },
    source: "defaults",
    llmEventsAvailable: false,
    turnFlags: new Map(),
    lastContinueAt: new Map(),
    persistQueue: Promise.resolve(),
    mountWarned: false,
    appliedFor: new Set(),
  };

  async function initialize(ctx: ModEventHandlerContext | ModCommandContext): Promise<void> {
    if (rt.initialized) return;
    if (!rt.initPromise) {
      rt.initPromise = (async () => {
        const agentId = ctx.agent?.id ?? null;
        const memoryDir = (ctx as ModEventHandlerContext).memfs?.memoryDir ?? process.env.MEMORY_DIR ?? null;
        rt.agentId = agentId;
        rt.llmEventsAvailable = letta.capabilities?.events?.llm === true;
        rt.mount = await ensureMount(
          memoryDir,
          agentId,
          process.env.LETTA_BASE_URL ?? null,
          process.env.LETTA_API_KEY ?? null,
        );
        if (!rt.mount.available && !rt.mountWarned) {
          rt.mountWarned = true;
          letta.diagnostics?.report({
            message: "amazing-grace: squad-mods mount unavailable; running on built-in defaults",
            severity: "warning",
          });
        }
        const loaded = await loadContext(rt.mount, agentId ?? "?");
        rt.config = loaded.config;
        rt.state = loaded.state;
        rt.source = loaded.source;
        if (canonicalizeBenchState(rt.state, rt.config.ladder)) {
          persist("canonicalize persisted bench handles");
        }
      })();
    }
    await rt.initPromise;
    rt.initialized = true;
  }

  function flagsFor(conversationId: string): TurnFlags {
    let flags = rt.turnFlags.get(conversationId);
    if (!flags) {
      flags = { acted: false, switched: false };
      rt.turnFlags.set(conversationId, flags);
    }
    return flags;
  }

  function persist(eventSummary: string): void {
    rt.persistQueue = rt.persistQueue
      .then(() => saveState(rt.mount, rt.agentId ?? "?", rt.state, rt.config, eventSummary))
      .then((result: { pushed: boolean; error?: string }) => {
        if (!result.pushed && result.error && !rt.mountWarned) {
          rt.mountWarned = true;
          letta.diagnostics?.report({
            message: `amazing-grace: ledger push deferred (${trim(result.error, 120)})`,
            severity: "warning",
          });
        }
      })
      .catch(() => {});
  }

  interface SwitchOutcome {
    from: string | null;
    to: string;
    changed: boolean;
  }

  async function evaluateAndSwitch(
    ctx: ModEventHandlerContext | ModCommandContext,
    opts: { needsMultimodal?: boolean; conversationScope?: boolean; reason: string; detail?: string },
  ): Promise<SwitchOutcome | null> {
    await initialize(ctx);
    if (rt.state.paused) return null;
    const ladder = rt.config.ladder;
    if (ladder.length === 0) return null;

    let target: LadderRung | null;
    if (rt.state.pinned) {
      const pinnedIndex = findRung(ladder, rt.state.pinned);
      if (pinnedIndex === -1) return null; // pin outside the ladder: leave the model alone
      target = ladder[pinnedIndex];
    } else {
      target = targetRung(rt.config, activeCooldowns(rt.state, Date.now()), rt.state.dead, Date.now(), opts.needsMultimodal === true);
    }
    if (!target) return null;

    const current = ctx.model?.id ?? null;
    if (handlesMatch(current, target.handle)) return { from: current, to: target.handle, changed: false };

    const currentIndex = findRung(ladder, current);
    if (currentIndex === -1 && !rt.config.enforceLadder) return null;

    const scope = opts.conversationScope ? "conversation" : "agent";
    try {
      await ctx.conversation.updateLlmConfig?.({ model: target.handle, scope });
    } catch {
      return null; // switch failed; the next decision point retries
    }

    const targetIndex = findRung(ladder, target.handle);
    const kind = changeKind(currentIndex, targetIndex, opts.needsMultimodal === true);
    appendEvent(rt.state, {
      ts: nowIso(),
      kind,
      from: current,
      to: target.handle,
      reason: opts.reason,
      detail: opts.detail,
      conversationId: ctx.conversation?.id ?? null,
    });
    persist(`${kind} ${current ?? "?"} -> ${target.handle} (${opts.reason})`);
    flagsFor(ctx.conversation?.id ?? "unknown").switched = true;
    return { from: current, to: target.handle, changed: true };
  }

  function bench(ctx: ModEventHandlerContext, handle: string, kind: FailureKind, detail: string): Promise<SwitchOutcome | null> {
    handle = canonicalRungHandle(rt.config.ladder, handle);
    if (kind === "auth" || kind === "invalid-model") {
      markDead(rt.state, handle);
      const event: GraceEvent = {
        ts: nowIso(),
        kind: "dead-mark",
        from: handle,
        to: null,
        reason: kind,
        detail: trim(detail, 200),
        conversationId: ctx.conversation?.id ?? null,
      };
      appendEvent(rt.state, event);
      persist(`dead-mark ${handle} (${kind})`);
    } else if (kind === "quota") {
      markCooldown(rt.state, handle, rt.config.cooldownMinutes, Date.now());
      // Persist immediately: evaluateAndSwitch only persists after a
      // successful switch, and there may be no healthy rung to switch to.
      persist(`cooldown ${handle} (${kind})`);
    }
    return evaluateAndSwitch(ctx, { reason: kind, detail: trim(detail, 200) });
  }

  function recordProbe(
    ctx: ModEventHandlerContext | ModCommandContext,
    handle: string,
    result: ProbeResult,
    via: string,
  ): void {
    appendEvent(rt.state, {
      ts: nowIso(),
      kind: "probe",
      from: handle,
      to: null,
      reason: result,
      detail: via,
      conversationId: ctx.conversation?.id ?? null,
    });
    persist(`probe ${handle} -> ${result} (${via})`);
  }

  async function recoverByProbe(ctx: ModEventHandlerContext, handle: string): Promise<void> {
    handle = canonicalRungHandle(rt.config.ladder, handle);
    const outcome = await probeRung(ctx.conversation, handle);
    const { result } = outcome;
    recordProbe(ctx, handle, result, outcome.detail ? `turn-end: ${trim(outcome.detail, 160)}` : "turn-end");
    if (result === "quota") {
      markCooldown(rt.state, handle, rt.config.cooldownMinutes, Date.now());
      persist(`cooldown ${handle} (quota, probe)`);
      await evaluateAndSwitch(ctx, { reason: "quota", detail: "probe" });
    } else if (result === "auth" || result === "invalid-model") {
      markDead(rt.state, handle);
      appendEvent(rt.state, { ts: nowIso(), kind: "dead-mark", from: handle, to: null, reason: result, detail: "probe", conversationId: ctx.conversation?.id ?? null });
      persist(`dead-mark ${handle} (${result}, probe)`);
      await evaluateAndSwitch(ctx, { reason: result, detail: "probe" });
    } else if (result === "image") {
      await evaluateAndSwitch(ctx, { needsMultimodal: true, conversationScope: true, reason: "image-content", detail: "probe" });
    }
    // ok / unavailable / transient: no action
  }

  // ── Events ──

  if (letta.capabilities?.events?.lifecycle) {
    disposers.push(
      letta.events.on<ModConversationOpenEvent>("conversation_open", async (event, ctx) => {
        await initialize(ctx);
        const cid = event.conversationId ?? "unknown";
        rt.turnFlags.set(cid, { acted: false, switched: false });
        rt.appliedFor.add(cid);
        await recoverBenchedRungs(ctx);
        await evaluateAndSwitch(ctx, { reason: "conversation-open" });
      }),
    );
  }

  if (letta.capabilities?.events?.turns) {
    disposers.push(
      letta.events.on<ModTurnStartEvent>("turn_start", async (event, ctx) => {
        await initialize(ctx);
        const cid = event.conversationId ?? "unknown";
        rt.turnFlags.set(cid, { acted: false, switched: false });
        if (rt.state.paused) return;
        // Surfaces without lifecycle events (headless runs, Desktop listeners)
        // may never fire conversation_open, so enforce the ladder on the first
        // turn of each conversation as well.
        if (!rt.appliedFor.has(cid)) {
          rt.appliedFor.add(cid);
          await evaluateAndSwitch(ctx, { reason: "turn-start" });
        }
        if (!inputHasImages(event.input)) return;
        const index = findRung(rt.config.ladder, ctx.model?.id);
        // Off-ladder models are assumed multimodal; only ladder rungs carry the flag.
        if (index >= 0 && !rt.config.ladder[index].multimodal) {
          await evaluateAndSwitch(ctx, { needsMultimodal: true, conversationScope: true, reason: "image-content" });
        }
      }),
    );

    disposers.push(
      letta.events.on<ModTurnEndEvent>("turn_end", async (event, ctx) => {
        await initialize(ctx);
        if (event.stopReason !== "error" || rt.state.paused) return;
        const conversationId = event.conversationId ?? "unknown";
        const flags = rt.turnFlags.get(conversationId);

        if (!flags?.acted) {
          // First classify any provider text visible in the failed turn: image
          // rejections name the content type, which a text probe cannot detect.
          const kind = classifyFailure(event.assistantMessage ?? "");
          if (kind === "image") {
            await evaluateAndSwitch(ctx, { needsMultimodal: true, conversationScope: true, reason: "image-content", detail: trim(event.assistantMessage ?? "", 200) });
          } else if (!rt.llmEventsAvailable) {
            // Cloud backend: no llm_end events, so probe to classify.
            const current = ctx.model?.id ?? null;
            if (current && rt.config.probeEnabled) {
              await recoverByProbe(ctx, current);
            } else if (kind !== "transient") {
              await bench(ctx, current ?? "?", kind, event.assistantMessage ?? "");
            }
          }
          // On the local backend llm_end is authoritative and already ran.
        }

        if (rt.turnFlags.get(conversationId)?.switched && rt.config.autoContinue) {
          const last = rt.lastContinueAt.get(conversationId) ?? 0;
          if (Date.now() - last > CONTINUE_MIN_INTERVAL_MS) {
            rt.lastContinueAt.set(conversationId, Date.now());
            return {
              continue:
                "The previous request failed on a benched model and amazing-grace switched this agent to a healthy rung. Please retry the last request.",
            };
          }
        }
        return undefined;
      }),
    );
  }

  if (letta.capabilities?.events?.tools) {
    disposers.push(
      letta.events.on<ModToolEndEvent>("tool_end", async (event, ctx) => {
        await initialize(ctx);
        if (rt.state.paused || event.status !== "success") return;
        if (!toolResultLikelyImage(event.toolName, event.args)) return;
        const index = findRung(rt.config.ladder, ctx.model?.id);
        if (index >= 0 && !rt.config.ladder[index].multimodal) {
          await evaluateAndSwitch(ctx, {
            needsMultimodal: true,
            conversationScope: true,
            reason: "image-tool-result",
            detail: event.toolName,
          });
        }
      }),
    );
  }

  if (letta.capabilities?.events?.llm) {
    disposers.push(
      letta.events.on<ModLlmEndEvent>("llm_end", async (event, ctx) => {
        await initialize(ctx);
        if (!event.error || rt.state.paused) return;
        const text = `${event.error.message} ${event.error.detail}`;
        const kind = classifyFailure(text);
        if (kind === "transient") return;
        if (kind === "image") {
          await evaluateAndSwitch(ctx, { needsMultimodal: true, conversationScope: true, reason: "image-content", detail: trim(text, 200) });
          return;
        }
        flagsFor(ctx.conversation?.id ?? "unknown").acted = true;
        await bench(ctx, event.model, kind, text);
      }),
    );
  }

  // ── Recovery: benched rungs are re-probed at the next conversation open ──
  // (Probes fork a conversation, so they need event context; a timer has none.
  // In-session upgrades therefore arrive via /amazing-grace sync or the next
  // conversation; in-session downgrades happen immediately via error paths.)

  async function recoverBenchedRungs(ctx: ModEventHandlerContext): Promise<void> {
    if (!rt.config.probeEnabled || rt.state.paused) return;
    const now = Date.now();
    // Probe dead rungs and rungs whose cooldown has just expired. Rungs still
    // inside their cooldown window are skipped, so the window actually
    // suppresses probe traffic and frequent conversation opens cannot extend
    // a cooldown indefinitely; an expired rung gets its promised recovery
    // probe before evaluateAndSwitch can select it again.
    const expired = new Set(expiredCooldowns(rt.state, now));
    let changed = pruneCooldowns(rt.state, now);
    for (const rung of rt.config.ladder) {
      const isDead = rt.state.dead.includes(rung.handle);
      if (!isDead && !expired.has(rung.handle)) continue;
      const outcome = await probeRung(ctx.conversation, rung.handle);
      const { result } = outcome;
      appendEvent(rt.state, { ts: nowIso(), kind: "probe", from: rung.handle, to: null, reason: result, detail: outcome.detail ? `recovery: ${trim(outcome.detail, 160)}` : "recovery", conversationId: ctx.conversation?.id ?? null });
      changed = true;
      if (result === "ok") {
        if (revive(rt.state, rung.handle)) {
          appendEvent(rt.state, { ts: nowIso(), kind: "recover", from: rung.handle, to: null, reason: "probe-ok", conversationId: ctx.conversation?.id ?? null });
        }
      } else if (result === "quota") {
        // Still limited: start a fresh cooldown from now.
        markCooldown(rt.state, rung.handle, rt.config.cooldownMinutes, now);
      }
      // auth/invalid-model keep the rung dead; unavailable/transient change nothing.
    }
    if (changed) persist("recovery poll");
  }

  // ── Commands ──

  if (letta.capabilities?.commands && letta.commands) {
    disposers.push(
      letta.commands.register({
        id: "amazing-grace",
        description: "Graceful model degradation: status, pause, resume, pin, sync, probe",
        args: "[status|pause|resume|pin <handle>|pin off|sync|probe [handle]]",
        run: async (ctx: ModCommandContext): Promise<ModCommandResult> => {
          await initialize(ctx);
          const [sub, arg] = ctx.args.trim().split(/\s+/);
          const ladder = rt.config.ladder;
          switch (sub || "status") {
            case "status": {
              const current = ctx.model?.id ?? null;
              const index = findRung(ladder, current);
              const lines = [
                `model: ${current ?? "?"} ${index >= 0 ? `(rung ${index + 1}/${ladder.length})` : "(off-ladder)"}`,
                `config source: ${rt.source}${rt.mount.available ? "" : " (mount unavailable)"}`,
                `paused: ${rt.state.paused}`,
                `pinned: ${rt.state.pinned ?? "none"}`,
                `cooldowns: ${Object.keys(activeCooldowns(rt.state, Date.now())).join(", ") || "none"}`,
                `dead: ${rt.state.dead.join(", ") || "none"}`,
                "recent events:",
                ...rt.state.events.slice(-5).map((e) => `  ${e.ts} ${e.kind} ${e.from ?? "-"} -> ${e.to ?? "-"} (${e.reason})`),
              ];
              return { type: "output", output: lines.join("\n") };
            }
            case "pause": {
              rt.state.paused = true;
              persist("pause");
              return { type: "output", output: "amazing-grace paused. Switching is suspended until /amazing-grace resume." };
            }
            case "resume": {
              rt.state.paused = false;
              persist("resume");
              const outcome = await evaluateAndSwitch(ctx, { reason: "resume" });
              return { type: "output", output: `amazing-grace resumed.${outcome?.changed ? ` Switched to ${outcome.to}.` : ""}` };
            }
            case "pin": {
              if (!arg || arg === "off") {
                rt.state.pinned = null;
                persist("pin off");
                return { type: "output", output: "Pin cleared. Ladder evaluation governs again." };
              }
              rt.state.pinned = arg;
              persist(`pin ${arg}`);
              return { type: "output", output: `Pinned to ${arg}. Run /amazing-grace pin off to release.` };
            }
            case "sync": {
              const loaded = await loadContext(rt.mount, rt.agentId ?? "?");
              rt.config = loaded.config;
              rt.state = loaded.state;
              rt.source = loaded.source;
              if (canonicalizeBenchState(rt.state, rt.config.ladder)) {
                persist("canonicalize persisted bench handles");
              }
              const outcome = await evaluateAndSwitch(ctx, { reason: "manual-sync" });
              return {
                type: "output",
                output: `Synced from ${rt.source}.${outcome?.changed ? ` Switched to ${outcome.to}.` : " No switch needed."}`,
              };
            }
            case "probe": {
              if (!rt.config.probeEnabled) return { type: "output", output: "Probes disabled in config." };
              const handles = arg && findRung(ladder, arg) >= 0 ? [arg] : ladder.map((r) => r.handle);
              const results: string[] = [];
              for (const handle of handles) {
                const outcome = await probeRung(ctx.conversation, handle);
                recordProbe(ctx, handle, outcome.result, outcome.detail ? `command: ${trim(outcome.detail, 160)}` : "command");
                results.push(`${handle}: ${outcome.result}${outcome.detail ? ` (${trim(outcome.detail, 160)})` : ""}`);
              }
              return { type: "output", output: results.join("\n") };
            }
            default:
              return { type: "output", output: `Unknown subcommand: ${sub}. Use status, pause, resume, pin, sync, or probe.` };
          }
        },
      }),
    );
  }

  // ── Panel (optional surface) ──

  if (letta.capabilities?.ui?.panels && letta.ui) {
    const panel = letta.ui.openPanel({
      id: "amazing-grace",
      order: -1,
      render: (ctx) => {
        if (!rt.initialized) return "";
        const current = ctx.model?.id ?? null;
        const index = findRung(rt.config.ladder, current);
        const position = index >= 0 ? `${index + 1}/${rt.config.ladder.length}` : "off-ladder";
        const cooling = Object.keys(activeCooldowns(rt.state, Date.now())).length;
        const benched = rt.state.paused ? "paused" : cooling > 0 ? `${cooling} cooling` : rt.state.dead.length > 0 ? `${rt.state.dead.length} dead` : "healthy";
        return ctx.row("", `rung [${position}] ${benched}`, ctx.width);
      },
    });
    disposers.push(() => panel.close());
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
