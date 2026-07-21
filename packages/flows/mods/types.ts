// Minimal type declarations for the Letta Code mod runtime.
// These are inferred from first-party mods; the real types are injected by the runtime.

export interface ModConversationHandle {
  id?: string;
  fork?: (options?: { hidden?: boolean }) => Promise<ModConversationHandle>;
}

export interface ModModelContext {
  id: string;
  displayName?: string;
  provider?: string;
  reasoningEffort?: string | null;
}

export interface LettaToolContext {
  args: Record<string, unknown>;
  cwd?: string;
  workingDirectory?: string;
  conversation?: ModConversationHandle;
  agent?: { id?: string; name?: string | null };
  model?: ModModelContext;
  [key: string]: unknown;
}

export interface LettaToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  approvalPolicy?: "auto" | "alwaysAsk" | "ask" | string;
  parallelSafe?: boolean;
  run(ctx: LettaToolContext): unknown;
}

export interface LettaCommandContext {
  args?: string | Record<string, unknown>;
  cwd?: string;
  workingDirectory?: string;
  conversation?: ModConversationHandle;
  agent?: { id?: string; name?: string | null };
  model?: ModModelContext;
  [key: string]: unknown;
}

export interface LettaCommandDefinition {
  id: string;
  description: string;
  args?: string;
  runWhenBusy?: boolean;
  run(ctx: LettaCommandContext): unknown;
}

export interface LettaEvent {
  toolName?: string;
  tool_call_id?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  result?: unknown;
  output?: unknown;
  resultText?: unknown;
  status?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface LettaEventHandlerContext {
  cwd?: string;
  workingDirectory?: string;
  conversation?: ModConversationHandle;
  agent?: { id?: string; name?: string | null };
  model?: ModModelContext;
  [key: string]: unknown;
}

export interface LettaCapabilities {
  tools?: boolean;
  commands?: boolean;
  permissions?: boolean;
  events?: {
    turns?: boolean;
    tools?: boolean;
    llm?: boolean;
    compact?: boolean;
  };
}

export interface LettaModContext {
  capabilities?: LettaCapabilities;
  tools?: {
    register: (tool: LettaToolDefinition) => (() => void);
  };
  commands?: {
    register: (command: LettaCommandDefinition) => (() => void);
  };
  events: {
    on: (event: string, handler: (event: LettaEvent, ctx: LettaEventHandlerContext) => unknown) => (() => void);
  };
  permissions?: {
    register: (permission: unknown) => (() => void);
  };
  client?: unknown;
}
