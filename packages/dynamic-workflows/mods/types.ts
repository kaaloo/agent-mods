// Minimal type declarations for the Letta Code mod runtime.
// The real types are injected by the Letta Code mod engine at runtime.

export interface LettaToolContext {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface LettaCommandContext {
  name: string;
  description: string;
  runWhenBusy?: boolean;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface LettaPanelContext {
  id: string;
  title: string;
  order?: number;
  content: string | string[] | (() => string | string[]);
}

export interface LettaModContext {
  tools: {
    register: (tool: LettaToolContext) => void;
  };
  commands: {
    register: (command: LettaCommandContext) => void;
  };
  events: {
    on: (event: string, handler: (event: Record<string, unknown>) => Promise<void> | void) => void;
  };
  panels: {
    register: (panel: LettaPanelContext) => void;
    update: (id: string, content: string | string[]) => void;
  };
  conversation: {
    fork: (options?: { hidden?: boolean }) => Promise<{ sendMessageStream: (messages: Array<{ role: string; content: string }>) => Promise<unknown> }>;
    sendMessageStream: (options?: { background?: boolean; messages?: Array<{ role: string; content: string }> }) => Promise<unknown>;
  };
}

export interface ToolCallEndEvent {
  tool_name?: string;
  result?: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: runtime shape is opaque
  [key: string]: any;
}
