// Shared configuration: the limit targets the mod raises conversations and
// the agent default to. Values live in squad-mods/context-bump/config.json;
// the same defaults ship here for environments without the mount.

export interface LimitTarget {
  contextWindow: number;
  maxOutputTokens: number;
}

export interface BumpConfig {
  default: LimitTarget;
  models: Record<string, Partial<LimitTarget>>;
  agents: Record<string, Partial<LimitTarget>>;
}

export const DEFAULT_CONTEXT_WINDOW = 256_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;

export function defaultConfig(): BumpConfig {
  return {
    default: { contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS },
    models: {},
    agents: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function parseLimit(raw: unknown): Partial<LimitTarget> | null {
  if (!isRecord(raw)) return null;
  const out: Partial<LimitTarget> = {};
  const contextWindow = positiveInt(raw.contextWindow);
  const maxOutputTokens = positiveInt(raw.maxOutputTokens);
  if (contextWindow !== null) out.contextWindow = contextWindow;
  if (maxOutputTokens !== null) out.maxOutputTokens = maxOutputTokens;
  return out.contextWindow !== undefined || out.maxOutputTokens !== undefined ? out : null;
}

export function parseConfig(raw: unknown): BumpConfig {
  const config = defaultConfig();
  if (!isRecord(raw)) return config;
  const def = parseLimit(raw.default);
  if (def) {
    if (def.contextWindow !== undefined) config.default.contextWindow = def.contextWindow;
    if (def.maxOutputTokens !== undefined) config.default.maxOutputTokens = def.maxOutputTokens;
  }
  if (isRecord(raw.models)) {
    for (const [handle, value] of Object.entries(raw.models)) {
      const parsed = parseLimit(value);
      if (parsed && handle.trim()) config.models[handle.trim()] = parsed;
    }
  }
  if (isRecord(raw.agents)) {
    for (const [id, value] of Object.entries(raw.agents)) {
      const parsed = parseLimit(value);
      if (parsed && id.trim()) config.agents[id.trim()] = parsed;
    }
  }
  return config;
}

/** Precedence: agent override > model override > default. */
export function resolveTarget(config: BumpConfig, model: string | null, agentId: string | null): LimitTarget {
  const modelOverride = model ? config.models[model] : undefined;
  const agentOverride = agentId ? config.agents[agentId] : undefined;
  return {
    contextWindow:
      agentOverride?.contextWindow ?? modelOverride?.contextWindow ?? config.default.contextWindow,
    maxOutputTokens:
      agentOverride?.maxOutputTokens ?? modelOverride?.maxOutputTokens ?? config.default.maxOutputTokens,
  };
}
