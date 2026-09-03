// Minimal type declarations for the Letta Code mod runtime.
// Inferred from first-party mods; the real types are injected by the runtime.

export interface ModUpdateLlmConfigOptions {
  model?: string;
  reasoningEffort?: string | null;
  contextWindow?: number;
  scope?: "conversation" | "agent";
}

export interface ModStreamChunk {
  type?: string;
  message_type?: string;
  [key: string]: unknown;
}

export interface ModSendMessageOptions {
  overrideModel?: string;
  streamTokens?: boolean;
  background?: boolean;
  workingDirectory?: string;
}

export interface ModSendMessageRequestOptions {
  headers?: Record<string, string>;
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface ModConversationHandle {
  id: string | null;
  fork: (options?: { hidden?: boolean }) => Promise<ModConversationHandle>;
  getHistory?: (options?: { limit?: number; order?: "asc" | "desc"; includeErrors?: boolean }) => Promise<unknown[]>;
  sendMessageStream: (
    messages: unknown[],
    options?: ModSendMessageOptions,
    requestOptions?: ModSendMessageRequestOptions,
  ) => Promise<AsyncIterable<ModStreamChunk>>;
  updateLlmConfig?: (options: ModUpdateLlmConfigOptions) => Promise<void>;
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

export interface ModTurnEndEvent {
  agentId: string | null;
  conversationId: string | null;
  stopReason: string;
  assistantMessage?: string;
}

export interface ModToolEndEvent {
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  status: "success" | "error";
  output: string;
}

export interface ModLlmEndError {
  message: string;
  detail: string;
  errorType: string;
  retryable: boolean;
}

export interface ModLlmEndEvent {
  agentId: string | null;
  conversationId: string | null;
  model: string;
  stopReason: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  durationMs: number;
  error?: ModLlmEndError;
}

export interface ModCommandContext {
  rawInput: string;
  command: string;
  args: string;
  argv: string[];
  conversation: ModConversationHandle & { id: string };
  cwd: string;
  agent: ModAgentContext;
  model: ModModelContext;
  [key: string]: unknown;
}

export type ModCommandResult =
  | { type: "prompt"; content: string; systemReminder?: boolean }
  | { type: "output"; output: string; success?: boolean }
  | { type: "handled" };

export interface ModCommandRegistration {
  id: string;
  description: string;
  args?: string;
  order?: number;
  runWhenBusy?: boolean;
  run: (context: ModCommandContext) => ModCommandResult | Promise<ModCommandResult>;
}

export interface ModPanelRenderContext {
  width: number;
  row: (left: string, right: string, width: number) => string;
  chalk?: { dim: (s: string) => string; yellow: (s: string) => string; green: (s: string) => string; red: (s: string) => string };
  model?: ModModelContext;
  agent?: ModAgentContext;
  [key: string]: unknown;
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

export interface LettaModContext {
  app: { version: string };
  capabilities: LettaCapabilities;
  events: {
    on: <T = unknown>(
      event: string,
      handler: (event: T, ctx: ModEventHandlerContext) => unknown,
    ) => () => void;
  };
  commands?: {
    register: (registration: ModCommandRegistration) => () => void;
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
