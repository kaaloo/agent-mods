// Minimal type declarations for the Letta Code mod runtime.
// These are inferred from first-party mods; the real types are injected by the runtime.

export interface ModConversationHandle {
  id?: string;
  fork?: (options?: { hidden?: boolean }) => Promise<ModConversationHandle>;
  sendMessageStream?: (messages: Array<{ role: string; content: string }>) => Promise<AsyncIterable<unknown>>;
}

export interface LettaToolContext {
  args: Record<string, unknown>;
  cwd?: string;
  workingDirectory?: string;
  conversation?: ModConversationHandle;
  agent?: { id?: string; name?: string | null };
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
  [key: string]: unknown;
}

export interface LettaCommandDefinition {
  id: string;
  description: string;
  args?: string;
  runWhenBusy?: boolean;
  run(ctx: LettaCommandContext): unknown;
}

export interface LettaPanelRenderContext {
  width?: number;
  cwd?: string;
  workingDirectory?: string;
  conversation?: ModConversationHandle;
  agent?: { id?: string; name?: string | null };
  [key: string]: unknown;
}

export interface LettaPanelDefinition {
  id: string;
  order?: number;
  render(ctx: LettaPanelRenderContext): string | string[];
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
  [key: string]: unknown;
}

export interface LettaCapabilities {
  tools?: boolean;
  commands?: boolean;
  permissions?: boolean;
  events?: {
    lifecycle?: boolean;
    turns?: boolean;
    tools?: boolean;
    llm?: boolean;
    compact?: boolean;
  };
  ui?: {
    panels?: boolean;
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
    on: (event: string, handler: (event: LettaEvent, ctx: LettaEventHandlerContext) => void) => (() => void);
  };
  permissions?: {
    register: (permission: unknown) => (() => void);
  };
  ui?: {
    openPanel: (panel: LettaPanelDefinition) => { update: () => void; close: () => void };
  };
  client?: unknown;
}
