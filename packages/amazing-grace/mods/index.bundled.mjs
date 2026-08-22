// mods/lib/classify.ts
var RULES = [
  {
    kind: "invalid-model",
    pattern: /model handle not found|model not found|unknown model|invalid model (handle|name|id)|does not exist[^.]*model/i
  },
  {
    kind: "auth",
    pattern: /invalid[ _-]?(api[ _-]?key|token)|unauthorized|authentication|forbidden|\b40[13]\b|permission denied/i
  },
  {
    kind: "quota",
    pattern: /rate[ _-]?limit|quota|usage[ _-]?limit|limit reached|exceeded your|exceeds?.*(limit|quota)|insufficient (credits?|funds|balance)|\b(402|429)\b|billing|past due|too many requests/i
  },
  {
    kind: "image",
    pattern: /messages\.content\.type is invalid|allowed values: ?\[.?text|image(s)? (is|are) not (supported|allowed)|does not (support|accept) images?|multimodal (support )?(is )?(not|required)|\.image\b/i
  }
];
function classifyFailure(text) {
  if (!text)
    return "transient";
  const value = String(text);
  for (const rule of RULES) {
    if (rule.pattern.test(value))
      return rule.kind;
  }
  return "transient";
}

// mods/lib/detect.ts
var IMAGE_EXTENSIONS = /\.(jpe?g|png|gif|webp|bmp|tiff?|heic|avif)$/i;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function contentHasImagePart(content) {
  if (typeof content === "string")
    return false;
  if (!Array.isArray(content))
    return false;
  for (const part of content) {
    if (!isRecord(part))
      continue;
    const type = part.type;
    if (type === "image" || type === "image_url" || type === "input_image")
      return true;
    if (isRecord(part.source) && part.source.type === "base64")
      return true;
    if (isRecord(part.image_url) || isRecord(part.image))
      return true;
  }
  return false;
}
function messageHasImage(message) {
  if (!isRecord(message))
    return false;
  if (contentHasImagePart(message.content))
    return true;
  if (Array.isArray(message.approvals)) {
    for (const approval of message.approvals) {
      if (!isRecord(approval))
        continue;
      if (isRecord(approval.tool_return) && contentHasImagePart(approval.tool_return.content))
        return true;
    }
  }
  if (isRecord(message.tool_return) && contentHasImagePart(message.tool_return.content))
    return true;
  return false;
}
function inputHasImages(input) {
  if (!Array.isArray(input))
    return false;
  return input.some((item) => messageHasImage(item));
}
var IMAGE_RESULT_TOOLS = new Set(["read", "read_file", "readfile", "open_files"]);
function toolResultLikelyImage(toolName, args) {
  if (!toolName || !args)
    return false;
  const normalized = toolName.toLowerCase().replace(/^multi_tool_use\./, "");
  if (!IMAGE_RESULT_TOOLS.has(normalized))
    return false;
  for (const key of ["file_path", "path", "file", "filename"]) {
    const value = args[key];
    if (typeof value === "string" && IMAGE_EXTENSIONS.test(value))
      return true;
  }
  return false;
}

// mods/lib/ladder.ts
var DEFAULT_LADDER = [
  { handle: "lc-zai-coding/glm-5.3", multimodal: false },
  { handle: "lc-qwen-code/qwen3.8-max", multimodal: true },
  { handle: "lc-codex/gpt-5.6-sol", multimodal: true },
  { handle: "lc-minimax/MiniMax-M3", multimodal: true },
  { handle: "lc-kimi-code/k3", multimodal: true }
];
function defaultConfig() {
  return {
    ladder: DEFAULT_LADDER.map((r) => ({ ...r })),
    cooldownMinutes: 60,
    autoContinue: true,
    probeEnabled: true,
    enforceLadder: true
  };
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseLadder(raw) {
  if (!Array.isArray(raw) || raw.length === 0)
    return null;
  const rungs = [];
  for (const item of raw) {
    if (!isRecord2(item))
      return null;
    const handle = item.handle;
    if (typeof handle !== "string" || !handle.trim())
      return null;
    rungs.push({ handle: handle.trim(), multimodal: item.multimodal !== false });
  }
  return rungs;
}
function parseConfig(raw) {
  const config = defaultConfig();
  if (!isRecord2(raw))
    return config;
  const ladder = parseLadder(raw.ladder);
  if (ladder)
    config.ladder = ladder;
  if (typeof raw.cooldownMinutes === "number" && raw.cooldownMinutes > 0) {
    config.cooldownMinutes = raw.cooldownMinutes;
  }
  if (typeof raw.autoContinue === "boolean")
    config.autoContinue = raw.autoContinue;
  if (typeof raw.probeEnabled === "boolean")
    config.probeEnabled = raw.probeEnabled;
  if (typeof raw.enforceLadder === "boolean")
    config.enforceLadder = raw.enforceLadder;
  return config;
}
function findRung(ladder, handle) {
  if (!handle)
    return -1;
  return ladder.findIndex((r) => r.handle === handle);
}
function targetRung(config, cooldowns, dead, now, needsMultimodal) {
  const ladder = config.ladder;
  if (ladder.length === 0)
    return null;
  let i = 0;
  while (i < ladder.length) {
    const handle = ladder[i].handle;
    if (dead.includes(handle)) {
      i += 1;
      continue;
    }
    const until = cooldowns[handle];
    if (typeof until === "number" && until > now) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= ladder.length)
    i = ladder.length - 1;
  if (needsMultimodal) {
    let j = i;
    while (j < ladder.length && !ladder[j].multimodal)
      j += 1;
    if (j < ladder.length)
      return ladder[j];
    return ladder[i];
  }
  return ladder[i];
}

// mods/lib/ledger.ts
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// mods/lib/state.ts
var MAX_EVENTS = 500;
function emptyState(agentId) {
  return {
    agentId,
    updatedAt: new Date(0).toISOString(),
    paused: false,
    pinned: null,
    cooldowns: {},
    dead: [],
    events: []
  };
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseState(raw, agentId) {
  const state = emptyState(agentId);
  if (!isRecord3(raw))
    return state;
  if (typeof raw.paused === "boolean")
    state.paused = raw.paused;
  if (typeof raw.pinned === "string" && raw.pinned.trim())
    state.pinned = raw.pinned.trim();
  if (isRecord3(raw.cooldowns)) {
    for (const [handle, until] of Object.entries(raw.cooldowns)) {
      if (typeof until === "string" && !Number.isNaN(Date.parse(until))) {
        state.cooldowns[handle] = until;
      }
    }
  }
  if (Array.isArray(raw.dead)) {
    state.dead = raw.dead.filter((h) => typeof h === "string");
  }
  if (Array.isArray(raw.events)) {
    for (const item of raw.events) {
      if (!isRecord3(item))
        continue;
      if (typeof item.ts !== "string" || typeof item.kind !== "string")
        continue;
      state.events.push({
        ts: item.ts,
        kind: item.kind,
        from: typeof item.from === "string" ? item.from : null,
        to: typeof item.to === "string" ? item.to : null,
        reason: typeof item.reason === "string" ? item.reason : "unknown",
        detail: typeof item.detail === "string" ? item.detail : undefined,
        conversationId: typeof item.conversationId === "string" ? item.conversationId : null
      });
    }
  }
  return state;
}
function appendEvent(state, event) {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    state.events.splice(0, state.events.length - MAX_EVENTS);
  }
  state.updatedAt = event.ts;
}
function activeCooldowns(state, now) {
  const out = {};
  for (const [handle, until] of Object.entries(state.cooldowns)) {
    const t = Date.parse(until);
    if (!Number.isNaN(t) && t > now)
      out[handle] = t;
  }
  return out;
}
function pruneCooldowns(state, now) {
  let changed = false;
  for (const [handle, until] of Object.entries(state.cooldowns)) {
    const t = Date.parse(until);
    if (Number.isNaN(t) || t <= now) {
      delete state.cooldowns[handle];
      changed = true;
    }
  }
  return changed;
}
function markCooldown(state, handle, minutes, now) {
  state.cooldowns[handle] = new Date(now + minutes * 60000).toISOString();
}
function markDead(state, handle) {
  if (!state.dead.includes(handle))
    state.dead.push(handle);
}
function revive(state, handle) {
  let changed = false;
  if (state.dead.includes(handle)) {
    state.dead = state.dead.filter((h) => h !== handle);
    changed = true;
  }
  if (state.cooldowns[handle]) {
    delete state.cooldowns[handle];
    changed = true;
  }
  return changed;
}
function changeKind(fromIndex, toIndex, needsMultimodal) {
  if (needsMultimodal)
    return "image-downgrade";
  if (fromIndex < 0)
    return "config-change";
  return toIndex > fromIndex ? "downgrade" : "upgrade";
}

// mods/lib/ledger.ts
var execFileAsync = promisify(execFile);
var REPO_NAME = "squad-mods";
var MOD_DIR = "amazing-grace";
var LEDGER_DIR = "ledger";
var CONFIG_FILE = "config.json";
function mountPath(memoryDir) {
  if (!memoryDir)
    return null;
  return path.join(path.dirname(path.resolve(memoryDir)), REPO_NAME);
}
function ledgerFile(mount, agentId) {
  return path.join(mount, MOD_DIR, LEDGER_DIR, `${agentId}.json`);
}
function configFile(mount) {
  return path.join(mount, MOD_DIR, CONFIG_FILE);
}
function repositoryUrl(baseUrl, agentId) {
  return `${baseUrl.replace(/\/+$/, "")}/v1/git/${agentId}/repositories/${REPO_NAME}.git`;
}
async function git(cwd, args, token) {
  try {
    const options = { maxBuffer: 10 * 1024 * 1024 };
    if (cwd)
      options.cwd = cwd;
    const finalArgs = token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`, ...args] : args;
    await execFileAsync("git", finalArgs, options);
    return { ok: true, stderr: "" };
  } catch (error) {
    const err = error;
    return { ok: false, stderr: (err.stderr || err.message || "git failed").slice(0, 500) };
  }
}
async function ensureMount(memoryDir, agentId, baseUrl, token) {
  const mount = mountPath(memoryDir);
  if (!mount || !agentId)
    return { path: mount ?? REPO_NAME, available: false, clonedByMod: false };
  if (existsSync(path.join(mount, ".git"))) {
    return { path: mount, available: true, clonedByMod: false };
  }
  if (!baseUrl || !token)
    return { path: mount, available: false, clonedByMod: false };
  mkdirSync(path.dirname(mount), { recursive: true });
  const url = repositoryUrl(baseUrl, agentId);
  const clone = await git(path.dirname(mount), ["clone", url, mount], token);
  if (!clone.ok)
    return { path: mount, available: false, clonedByMod: false };
  await configureCredentialHelper(mount, baseUrl, token, agentId);
  return { path: mount, available: true, clonedByMod: true };
}
async function configureCredentialHelper(mount, baseUrl, token, agentId) {
  const host = new URL(baseUrl).host;
  await git(mount, ["config", `credential.https://${host}.helper`, ""]);
  await git(mount, [
    "config",
    "--add",
    `credential.https://${host}.helper`,
    `!f() { echo "username=letta"; echo "password=${token}"; }; f`
  ]);
  await git(mount, ["config", "letta.agentId", agentId]);
  await git(mount, ["config", "user.email", `${agentId}@letta.com`]);
  await git(mount, ["config", "user.name", "amazing-grace"]);
  await git(mount, ["config", "commit.gpgsign", "false"]);
}
async function pullMount(mount) {
  const result = await git(mount, ["pull", "--rebase", "--autostash", "origin", "main"]);
  return result.ok;
}
async function commitAndPush(mount, files, message) {
  if (files.length === 0)
    return { committed: false, pushed: false };
  const add = await git(mount, ["add", "--", ...files]);
  if (!add.ok)
    return { committed: false, pushed: false, error: add.stderr };
  const status = await git(mount, ["diff", "--cached", "--quiet"]);
  if (status.ok)
    return { committed: false, pushed: false };
  const commit = await git(mount, [
    "commit",
    "-m",
    `${message}

\uD83D\uDC7E Generated with [Letta Code](https://letta.com)

Co-Authored-By: Letta Code <noreply@letta.com>`
  ]);
  if (!commit.ok)
    return { committed: false, pushed: false, error: commit.stderr };
  const push = await git(mount, ["push", "origin", "main"]);
  if (push.ok)
    return { committed: true, pushed: true };
  const rebase = await git(mount, ["pull", "--rebase", "--autostash", "origin", "main"]);
  if (!rebase.ok)
    return { committed: true, pushed: false, error: push.stderr };
  const retry = await git(mount, ["push", "origin", "main"]);
  return retry.ok ? { committed: true, pushed: true } : { committed: true, pushed: false, error: retry.stderr };
}
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function cacheFile(agentId) {
  return path.join(os.homedir(), ".letta", "mods", "state", "amazing-grace", `${agentId}.json`);
}
async function loadContext(mountInfo, agentId) {
  if (mountInfo.available) {
    await pullMount(mountInfo.path);
  }
  const sharedConfig = mountInfo.available ? readJsonFile(configFile(mountInfo.path)) : null;
  const sharedState = mountInfo.available ? readJsonFile(ledgerFile(mountInfo.path, agentId)) : null;
  if (mountInfo.available && sharedConfig) {
    return {
      config: parseConfig(sharedConfig),
      state: parseState(sharedState, agentId),
      source: "shared",
      mount: mountInfo.path
    };
  }
  const cached = readJsonFile(cacheFile(agentId));
  if (cached) {
    return {
      config: parseConfig(cached.config ?? null),
      state: parseState(cached.state ?? null, agentId),
      source: "cache",
      mount: mountInfo.path
    };
  }
  return {
    config: parseConfig(null),
    state: parseState(null, agentId),
    source: "defaults",
    mount: mountInfo.path
  };
}
async function saveState(mountInfo, agentId, state, config, eventSummary) {
  state.updatedAt = new Date().toISOString();
  const cache = cacheFile(agentId);
  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, JSON.stringify({ state, config, updatedAt: state.updatedAt }, null, 2));
  if (!mountInfo.available)
    return { committed: false, pushed: false, error: "mount unavailable" };
  const file = ledgerFile(mountInfo.path, agentId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
  return commitAndPush(mountInfo.path, [path.relative(mountInfo.path, file)], `amazing-grace: ${eventSummary}`);
}

// mods/lib/probe.ts
function chunkErrorText(chunk) {
  if (typeof chunk !== "object" || chunk === null)
    return null;
  const record = chunk;
  const parts = [];
  for (const source of [record.error, record]) {
    if (typeof source === "string") {
      parts.push(source);
    } else if (typeof source === "object" && source !== null) {
      const src = source;
      for (const key of ["message", "detail", "error"]) {
        const value = src[key];
        if (typeof value === "string")
          parts.push(value);
        else if (typeof value === "object" && value !== null && typeof value.message === "string") {
          parts.push(value.message);
        }
      }
    }
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}
async function probeRung(conversation, handle) {
  try {
    const forked = await conversation.fork({ hidden: true });
    const stream = await forked.sendMessageStream([{ role: "user", content: "Reply with exactly: pong" }], { overrideModel: handle, streamTokens: false, background: true }, { maxRetries: 0 });
    let sawCompletion = false;
    let sawText = false;
    for await (const chunk of stream) {
      const type = chunk?.type;
      if (type === "error") {
        const text = chunkErrorText(chunk);
        return classifyFailure(text);
      }
      if (type === "assistant_message" || type === "message") {
        const record = chunk;
        const content = record.content ?? record.message;
        if (typeof content === "string" && content.length > 0)
          sawText = true;
      }
      if (type === "done" || type === "stop_reason" || type === "usage")
        sawCompletion = true;
    }
    if (sawText || sawCompletion)
      return "ok";
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

// mods/index.ts
var CONTINUE_MIN_INTERVAL_MS = 120000;
function nowIso() {
  return new Date().toISOString();
}
function trim(text, max) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
function activate(letta) {
  const disposers = [];
  letta.diagnostics?.report({ message: "amazing-grace: mod activated", severity: "warning" });
  const rt = {
    initialized: false,
    initPromise: null,
    agentId: null,
    mount: { path: "squad-mods", available: false, clonedByMod: false },
    config: defaultConfig(),
    state: { agentId: "?", updatedAt: nowIso(), paused: false, pinned: null, cooldowns: {}, dead: [], events: [] },
    source: "defaults",
    llmEventsAvailable: false,
    actedThisTurn: false,
    switchedThisTurn: false,
    lastContinueAt: new Map,
    persistQueue: Promise.resolve(),
    mountWarned: false,
    appliedFor: new Set
  };
  async function initialize(ctx) {
    if (rt.initialized)
      return;
    if (!rt.initPromise) {
      rt.initPromise = (async () => {
        const agentId = ctx.agent?.id ?? null;
        const memoryDir = ctx.memfs?.memoryDir ?? process.env.MEMORY_DIR ?? null;
        rt.agentId = agentId;
        rt.llmEventsAvailable = letta.capabilities?.events?.llm === true;
        rt.mount = await ensureMount(memoryDir, agentId, process.env.LETTA_BASE_URL ?? null, process.env.LETTA_API_KEY ?? null);
        if (!rt.mount.available && !rt.mountWarned) {
          rt.mountWarned = true;
          letta.diagnostics?.report({
            message: "amazing-grace: squad-mods mount unavailable; running on built-in defaults",
            severity: "warning"
          });
        }
        const loaded = await loadContext(rt.mount, agentId ?? "?");
        rt.config = loaded.config;
        rt.state = loaded.state;
        rt.source = loaded.source;
      })();
    }
    await rt.initPromise;
    rt.initialized = true;
  }
  function persist(eventSummary) {
    rt.persistQueue = rt.persistQueue.then(() => saveState(rt.mount, rt.agentId ?? "?", rt.state, rt.config, eventSummary)).then((result) => {
      if (!result.pushed && result.error && !rt.mountWarned) {
        rt.mountWarned = true;
        letta.diagnostics?.report({
          message: `amazing-grace: ledger push deferred (${trim(result.error, 120)})`,
          severity: "warning"
        });
      }
    }).catch(() => {});
  }
  async function evaluateAndSwitch(ctx, opts) {
    await initialize(ctx);
    if (rt.state.paused)
      return null;
    const ladder = rt.config.ladder;
    if (ladder.length === 0)
      return null;
    let target;
    if (rt.state.pinned) {
      const pinnedIndex = findRung(ladder, rt.state.pinned);
      if (pinnedIndex === -1)
        return null;
      target = ladder[pinnedIndex];
    } else {
      target = targetRung(rt.config, activeCooldowns(rt.state, Date.now()), rt.state.dead, Date.now(), opts.needsMultimodal === true);
    }
    if (!target)
      return null;
    const current = ctx.model?.id ?? null;
    if (current === target.handle)
      return { from: current, to: target.handle, changed: false };
    const currentIndex = findRung(ladder, current);
    if (currentIndex === -1 && !rt.config.enforceLadder)
      return null;
    const scope = opts.conversationScope ? "conversation" : "agent";
    try {
      await ctx.conversation.updateLlmConfig?.({ model: target.handle, scope });
    } catch {
      return null;
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
      conversationId: ctx.conversation?.id ?? null
    });
    persist(`${kind} ${current ?? "?"} -> ${target.handle} (${opts.reason})`);
    rt.switchedThisTurn = true;
    return { from: current, to: target.handle, changed: true };
  }
  function bench(ctx, handle, kind, detail) {
    if (kind === "auth" || kind === "invalid-model") {
      markDead(rt.state, handle);
      const event = {
        ts: nowIso(),
        kind: "dead-mark",
        from: handle,
        to: null,
        reason: kind,
        detail: trim(detail, 200),
        conversationId: ctx.conversation?.id ?? null
      };
      appendEvent(rt.state, event);
      persist(`dead-mark ${handle} (${kind})`);
    } else if (kind === "quota") {
      markCooldown(rt.state, handle, rt.config.cooldownMinutes, Date.now());
    }
    return evaluateAndSwitch(ctx, { reason: kind, detail: trim(detail, 200) });
  }
  async function recoverByProbe(ctx, handle) {
    const result = await probeRung(ctx.conversation, handle);
    if (result === "quota") {
      markCooldown(rt.state, handle, rt.config.cooldownMinutes, Date.now());
      await evaluateAndSwitch(ctx, { reason: "quota", detail: "probe" });
    } else if (result === "auth" || result === "invalid-model") {
      markDead(rt.state, handle);
      appendEvent(rt.state, { ts: nowIso(), kind: "dead-mark", from: handle, to: null, reason: result, detail: "probe", conversationId: ctx.conversation?.id ?? null });
      persist(`dead-mark ${handle} (${result}, probe)`);
      await evaluateAndSwitch(ctx, { reason: result, detail: "probe" });
    } else if (result === "image") {
      await evaluateAndSwitch(ctx, { needsMultimodal: true, conversationScope: true, reason: "image-content", detail: "probe" });
    }
  }
  if (letta.capabilities?.events?.lifecycle) {
    disposers.push(letta.events.on("conversation_open", async (event, ctx) => {
      await initialize(ctx);
      rt.actedThisTurn = false;
      rt.switchedThisTurn = false;
      rt.appliedFor.add(event.conversationId ?? "unknown");
      await recoverBenchedRungs(ctx);
      await evaluateAndSwitch(ctx, { reason: "conversation-open" });
    }));
  }
  if (letta.capabilities?.events?.turns) {
    disposers.push(letta.events.on("turn_start", async (event, ctx) => {
      await initialize(ctx);
      rt.actedThisTurn = false;
      rt.switchedThisTurn = false;
      if (rt.state.paused)
        return;
      const cid = event.conversationId ?? "unknown";
      if (!rt.appliedFor.has(cid)) {
        rt.appliedFor.add(cid);
        await evaluateAndSwitch(ctx, { reason: "turn-start" });
      }
      if (!inputHasImages(event.input))
        return;
      const index = findRung(rt.config.ladder, ctx.model?.id);
      if (index >= 0 && !rt.config.ladder[index].multimodal) {
        await evaluateAndSwitch(ctx, { needsMultimodal: true, conversationScope: true, reason: "image-content" });
      }
    }));
    disposers.push(letta.events.on("turn_end", async (event, ctx) => {
      await initialize(ctx);
      if (event.stopReason !== "error" || rt.state.paused)
        return;
      if (!rt.actedThisTurn) {
        const kind = classifyFailure(event.assistantMessage ?? "");
        if (kind === "image") {
          await evaluateAndSwitch(ctx, { needsMultimodal: true, conversationScope: true, reason: "image-content", detail: trim(event.assistantMessage ?? "", 200) });
        } else if (!rt.llmEventsAvailable) {
          const current = ctx.model?.id ?? null;
          if (current && rt.config.probeEnabled) {
            await recoverByProbe(ctx, current);
          } else if (kind !== "transient") {
            await bench(ctx, current ?? "?", kind, event.assistantMessage ?? "");
          }
        }
      }
      if (rt.switchedThisTurn && rt.config.autoContinue) {
        const conversationId = event.conversationId ?? "unknown";
        const last = rt.lastContinueAt.get(conversationId) ?? 0;
        if (Date.now() - last > CONTINUE_MIN_INTERVAL_MS) {
          rt.lastContinueAt.set(conversationId, Date.now());
          return {
            continue: "The previous request failed on a benched model and amazing-grace switched this agent to a healthy rung. Please retry the last request."
          };
        }
      }
      return;
    }));
  }
  if (letta.capabilities?.events?.tools) {
    disposers.push(letta.events.on("tool_end", async (event, ctx) => {
      await initialize(ctx);
      if (rt.state.paused || event.status !== "success")
        return;
      if (!toolResultLikelyImage(event.toolName, event.args))
        return;
      const index = findRung(rt.config.ladder, ctx.model?.id);
      if (index >= 0 && !rt.config.ladder[index].multimodal) {
        await evaluateAndSwitch(ctx, {
          needsMultimodal: true,
          conversationScope: true,
          reason: "image-tool-result",
          detail: event.toolName
        });
      }
    }));
  }
  if (letta.capabilities?.events?.llm) {
    disposers.push(letta.events.on("llm_end", async (event, ctx) => {
      await initialize(ctx);
      if (!event.error || rt.state.paused)
        return;
      const text = `${event.error.message} ${event.error.detail}`;
      const kind = classifyFailure(text);
      if (kind === "transient")
        return;
      if (kind === "image") {
        await evaluateAndSwitch(ctx, { needsMultimodal: true, conversationScope: true, reason: "image-content", detail: trim(text, 200) });
        return;
      }
      rt.actedThisTurn = true;
      await bench(ctx, event.model, kind, text);
    }));
  }
  async function recoverBenchedRungs(ctx) {
    if (!rt.config.probeEnabled || rt.state.paused)
      return;
    const now = Date.now();
    let changed = pruneCooldowns(rt.state, now);
    for (const rung of rt.config.ladder) {
      const benched = rt.state.dead.includes(rung.handle) || rt.state.cooldowns[rung.handle] !== undefined;
      if (!benched)
        continue;
      const result = await probeRung(ctx.conversation, rung.handle);
      if (result === "ok") {
        if (revive(rt.state, rung.handle)) {
          appendEvent(rt.state, { ts: nowIso(), kind: "recover", from: rung.handle, to: null, reason: "probe-ok", conversationId: ctx.conversation?.id ?? null });
          changed = true;
        }
      } else if (result === "quota") {
        markCooldown(rt.state, rung.handle, rt.config.cooldownMinutes, now);
        changed = true;
      }
    }
    if (changed)
      persist("recovery poll");
  }
  if (letta.capabilities?.commands && letta.commands) {
    disposers.push(letta.commands.register({
      id: "amazing-grace",
      description: "Graceful model degradation: status, pause, resume, pin, sync, probe",
      args: "[status|pause|resume|pin <handle>|pin off|sync|probe [handle]]",
      run: async (ctx) => {
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
              ...rt.state.events.slice(-5).map((e) => `  ${e.ts} ${e.kind} ${e.from ?? "-"} -> ${e.to ?? "-"} (${e.reason})`)
            ];
            return { type: "output", output: lines.join(`
`) };
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
            const outcome = await evaluateAndSwitch(ctx, { reason: "manual-sync" });
            return {
              type: "output",
              output: `Synced from ${rt.source}.${outcome?.changed ? ` Switched to ${outcome.to}.` : " No switch needed."}`
            };
          }
          case "probe": {
            if (!rt.config.probeEnabled)
              return { type: "output", output: "Probes disabled in config." };
            const handles = arg && findRung(ladder, arg) >= 0 ? [arg] : ladder.map((r) => r.handle);
            const results = [];
            for (const handle of handles) {
              const result = await probeRung(ctx.conversation, handle);
              results.push(`${handle}: ${result}`);
            }
            return { type: "output", output: results.join(`
`) };
          }
          default:
            return { type: "output", output: `Unknown subcommand: ${sub}. Use status, pause, resume, pin, sync, or probe.` };
        }
      }
    }));
  }
  if (letta.capabilities?.ui?.panels && letta.ui) {
    const panel = letta.ui.openPanel({
      id: "amazing-grace",
      order: -1,
      render: (ctx) => {
        if (!rt.initialized)
          return "";
        const current = ctx.model?.id ?? null;
        const index = findRung(rt.config.ladder, current);
        const position = index >= 0 ? `${index + 1}/${rt.config.ladder.length}` : "off-ladder";
        const cooling = Object.keys(activeCooldowns(rt.state, Date.now())).length;
        const benched = rt.state.paused ? "paused" : cooling > 0 ? `${cooling} cooling` : rt.state.dead.length > 0 ? `${rt.state.dead.length} dead` : "healthy";
        return ctx.row("grace", `${current ?? "?"} [${position}] ${benched}`, ctx.width);
      }
    });
    disposers.push(() => panel.close());
  }
  return () => {
    for (const dispose of disposers.reverse())
      dispose();
  };
}
export {
  activate as default
};
