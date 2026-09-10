// mods/lib/config.ts
var DEFAULT_CONTEXT_WINDOW = 256000;
var DEFAULT_MAX_OUTPUT_TOKENS = 65536;
function defaultConfig() {
  return {
    default: { contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
    models: {},
    agents: {}
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}
function parseLimit(raw) {
  if (!isRecord(raw))
    return null;
  const out = {};
  const contextWindow = positiveInt(raw.contextWindow);
  const maxOutputTokens = positiveInt(raw.maxOutputTokens);
  if (contextWindow !== null)
    out.contextWindow = contextWindow;
  if (maxOutputTokens !== null)
    out.maxOutputTokens = maxOutputTokens;
  return out.contextWindow !== undefined || out.maxOutputTokens !== undefined ? out : null;
}
function parseConfig(raw) {
  const config = defaultConfig();
  if (!isRecord(raw))
    return config;
  const def = parseLimit(raw.default);
  if (def) {
    if (def.contextWindow !== undefined)
      config.default.contextWindow = def.contextWindow;
    if (def.maxOutputTokens !== undefined)
      config.default.maxOutputTokens = def.maxOutputTokens;
  }
  if (isRecord(raw.models)) {
    for (const [handle, value] of Object.entries(raw.models)) {
      const parsed = parseLimit(value);
      if (parsed && handle.trim())
        config.models[handle.trim()] = parsed;
    }
  }
  if (isRecord(raw.agents)) {
    for (const [id, value] of Object.entries(raw.agents)) {
      const parsed = parseLimit(value);
      if (parsed && id.trim())
        config.agents[id.trim()] = parsed;
    }
  }
  return config;
}
function resolveTarget(config, model, agentId) {
  const modelOverride = model ? config.models[model] : undefined;
  const agentOverride = agentId ? config.agents[agentId] : undefined;
  return {
    contextWindow: agentOverride?.contextWindow ?? modelOverride?.contextWindow ?? config.default.contextWindow,
    maxOutputTokens: agentOverride?.maxOutputTokens ?? modelOverride?.maxOutputTokens ?? config.default.maxOutputTokens
  };
}

// mods/lib/ledger.ts
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var REPO_NAME = "squad-mods";
var MOD_DIR = "context-bump";
var CONFIG_FILE = "config.json";
function mountPath(memoryDir) {
  if (!memoryDir)
    return null;
  return path.join(path.dirname(path.resolve(memoryDir)), REPO_NAME);
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
  await git(mount, ["config", "user.name", "context-bump"]);
  await git(mount, ["config", "commit.gpgsign", "false"]);
}
async function pullMount(mount) {
  const result = await git(mount, ["pull", "--rebase", "--autostash", "origin", "main"]);
  return result.ok;
}
function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
async function loadConfig(mountInfo) {
  if (mountInfo.available) {
    await pullMount(mountInfo.path);
  }
  const shared = mountInfo.available ? readJsonFile(configFile(mountInfo.path)) : null;
  if (mountInfo.available && shared !== null) {
    return { config: parseConfig(shared), source: "shared", mount: mountInfo.path };
  }
  return { config: parseConfig(null), source: "defaults", mount: mountInfo.path };
}

// mods/lib/limits.ts
function raised(current, target) {
  if (typeof current !== "number")
    return null;
  if (current >= target)
    return null;
  return target;
}
function buildRaisePatch(current, target) {
  const patch = {};
  const contextWindow = raised(current.contextWindow, target.contextWindow);
  if (contextWindow !== null)
    patch.context_window_limit = contextWindow;
  const maxOutputTokens = raised(current.maxOutputTokens, target.maxOutputTokens);
  if (maxOutputTokens !== null)
    patch.model_settings = { max_output_tokens: maxOutputTokens };
  return Object.keys(patch).length > 0 ? patch : null;
}

// mods/index.ts
function formatTokens(n) {
  if (n >= 1e6)
    return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000)
    return `${Math.round(n / 1000)}k`;
  return String(n);
}
function activate(letta) {
  const disposers = [];
  letta.diagnostics?.report({ message: "context-bump: mod activated", severity: "warning" });
  const rt = {
    initialized: false,
    initPromise: null,
    agentId: null,
    mount: { path: "squad-mods", available: false, clonedByMod: false },
    config: defaultConfig(),
    source: "defaults",
    appliedFor: new Set,
    agentRaised: false,
    mountWarned: false
  };
  async function initialize(ctx) {
    if (rt.initialized)
      return;
    if (!rt.initPromise) {
      rt.initPromise = (async () => {
        const agentId = ctx.agent?.id ?? null;
        const memoryDir = ctx.memfs?.memoryDir ?? process.env.MEMORY_DIR ?? null;
        rt.agentId = agentId;
        rt.mount = await ensureMount(memoryDir, agentId, process.env.LETTA_BASE_URL ?? null, process.env.LETTA_API_KEY ?? null);
        if (!rt.mount.available && !rt.mountWarned) {
          rt.mountWarned = true;
          letta.diagnostics?.report({
            message: "context-bump: squad-mods mount unavailable; running on built-in defaults",
            severity: "warning"
          });
        }
        const loaded = await loadConfig(rt.mount);
        rt.config = loaded.config;
        rt.source = loaded.source;
      })();
    }
    await rt.initPromise;
    rt.initialized = true;
  }
  async function readCurrentLimits(conversationId, agentId) {
    const client = letta.client;
    if (!client || !conversationId || !agentId)
      return null;
    const [conversation, agent] = await Promise.all([
      client.conversations.retrieve(conversationId).catch(() => null),
      client.agents.retrieve(agentId).catch(() => null)
    ]);
    const conversationSettings = conversation?.model_settings ?? null;
    const agentSettings = agent?.model_settings ?? null;
    return {
      conversation: {
        contextWindow: typeof conversation?.context_window_limit === "number" ? conversation.context_window_limit : null,
        maxOutputTokens: typeof conversationSettings?.max_output_tokens === "number" ? conversationSettings.max_output_tokens : null
      },
      agent: {
        contextWindow: typeof agent?.context_window_limit === "number" ? agent.context_window_limit : null,
        maxOutputTokens: typeof agentSettings?.max_output_tokens === "number" ? agentSettings.max_output_tokens : null
      }
    };
  }
  async function raiseLimits(ctx, reason) {
    const conversationId = ctx.conversation?.id ?? null;
    const agentId = ctx.agent?.id ?? null;
    if (!conversationId || !agentId)
      return;
    const target = resolveTarget(rt.config, ctx.model?.id ?? null, agentId);
    const current = await readCurrentLimits(conversationId, agentId);
    if (!current)
      return;
    const conversationPatch = buildRaisePatch(current.conversation, target);
    if (conversationPatch) {
      await letta.client?.conversations.update(conversationId, conversationPatch).catch(() => {});
      letta.diagnostics?.report({ message: `context-bump: raised conversation (${reason})`, severity: "warning" });
    }
    if (!rt.agentRaised) {
      const agentPatch = buildRaisePatch(current.agent, target);
      if (agentPatch) {
        await letta.client?.agents.update(agentId, agentPatch).catch(() => {});
        letta.diagnostics?.report({ message: "context-bump: raised agent default", severity: "warning" });
      }
      rt.agentRaised = true;
    }
  }
  if (letta.capabilities?.events?.lifecycle) {
    disposers.push(letta.events.on("conversation_open", async (event, ctx) => {
      await initialize(ctx);
      const cid = event.conversationId ?? ctx.conversation?.id ?? "unknown";
      rt.appliedFor.add(cid);
      await raiseLimits(ctx, "conversation-open");
    }));
  }
  if (letta.capabilities?.events?.turns) {
    disposers.push(letta.events.on("turn_start", async (event, ctx) => {
      await initialize(ctx);
      const cid = event.conversationId ?? ctx.conversation?.id ?? "unknown";
      if (!rt.appliedFor.has(cid)) {
        rt.appliedFor.add(cid);
        await raiseLimits(ctx, "turn-start");
      }
    }));
  }
  if (letta.capabilities?.ui?.panels && letta.ui) {
    const panel = letta.ui.openPanel({
      id: "context-bump",
      order: -1,
      render: (ctx) => {
        if (!rt.initialized)
          return "";
        const target = resolveTarget(rt.config, ctx.model?.id ?? null, rt.agentId);
        const source = rt.source === "shared" ? "wiki" : "default";
        return ctx.row("", `bump ctx ${formatTokens(target.contextWindow)} · out ${formatTokens(target.maxOutputTokens)} [${source}]`, ctx.width);
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
