// Minimal type declarations for the Letta Code mod runtime.
// Inferred from first-party mods; the real types are injected by the runtime.

export interface ModConversationHandle {
  id: string | null;
  fork: (options?: { hidden?: boolean }) => Promise<ModConversationHandle>;
  updateLlmConfig?: (options: {
    model?: string;
    reasoningEffort?: string | null;
    contextWindow?: number;
    scope?: "conversation" | "agent";
  }) => Promise<void>;
}

export interface ModModelContext {
  id: string | null;
  displayName?: string | null;
  provider?: string | null;
}

export interface ModAgentContext {
  id: string | null;
  name: string | null;
}

export interface ModMemfsContext {
  enabled: boolean;
  memoryDir: string | null;
}

export interface ModEventHandlerContext {
  cwd: string;
  conversation: ModConversationHandle;
  agent: ModAgentContext;
  model: ModModelContext;
  memfs?: ModMemfsContext;
  permissionMode?: string | null;
  signal: AbortSignal;
  [key: string]: unknown;
}

export interface ModConversationOpenEvent {
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  previousConversationId?: string | null;
  reason: string;
}

export interface ModTurnStartEvent {
  agentId: string | null;
  conversationId: string | null;
  input: unknown[];
}

// The lazy SDK proxy exposed as letta.client. Both resources PATCH their
// entity: agents.update -> /v1/agents/{id}, conversations.update ->
// /v1/conversations/{id}. Bodies are merged on the server (model_settings is
// deep-merged), so sending only the fields we raise preserves provider
// settings such as provider_type, temperature, and strict.
export interface ModSdkClient {
  conversations: {
    retrieve: (id: string) => Promise<Record<string, unknown>>;
    update: (id: string, body: Record<string, unknown>) => Promise<unknown>;
  };
  agents: {
    retrieve: (id: string) => Promise<Record<string, unknown>>;
    update: (id: string, body: Record<string, unknown>) => Promise<unknown>;
  };
}

export interface LettaCapabilities {
  tools: boolean;
  commands: boolean;
  events: {
    lifecycle: boolean;
    tools: boolean;
    turns: boolean;
    compact: boolean;
    llm: boolean;
  };
  permissions: boolean;
  providers: boolean;
  ui: { panels: boolean };
}

export interface ModPanelRenderContext {
  width: number;
  row: (left: string, right: string, width: number) => string;
  chalk?: {
    dim: (s: string) => string;
    yellow: (s: string) => string;
    green: (s: string) => string;
    red: (s: string) => string;
  };
  model?: ModModelContext;
  agent?: ModAgentContext;
  [key: string]: unknown;
}

export interface LettaModContext {
  app: { version: string };
  capabilities: LettaCapabilities;
  client?: ModSdkClient;
  events: {
    on: <T = unknown>(
      event: string,
      handler: (event: T, ctx: ModEventHandlerContext) => unknown,
    ) => () => void;
  };
  ui?: {
    openPanel: (options: {
      id: string;
      order?: number;
      render: (ctx: ModPanelRenderContext) => string | string[];
    }) => { close: () => void; update: (options?: { order?: number }) => void };
  };
  diagnostics?: {
    report: (options: { message: string; severity?: "error" | "warning" }) => void;
  };
}
