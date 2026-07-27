// Minimal type declarations for the Letta Code mod runtime.
// Inferred from first-party mods; the real types are injected by the runtime.

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

export interface LettaEvent {
  agentId?: string | null;
  conversationId?: string | null;
  toolCallId?: string | null;
  toolName?: string;
  args?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  result?: unknown;
  output?: unknown;
  resultText?: string;
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
    register: (command: unknown) => (() => void);
  };
  events: {
    on: (event: string, handler: (event: LettaEvent, ctx: LettaEventHandlerContext) => unknown) => (() => void);
  };
  permissions?: {
    register: (permission: PermissionOverlay) => (() => void);
  };
  client?: unknown;
}

export interface PermissionEvent {
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  workingDirectory: string;
  permissionMode: string | null;
  phase: "approval" | "execution";
}

export interface PermissionOverlay {
  id: string;
  description: string;
  check(event: PermissionEvent): PermissionDecision;
}

export type PermissionDecision =
  | { decision: "allow"; reason?: string }
  | { decision: "ask"; reason?: string }
  | { decision: "deny"; reason?: string }
  | undefined;

// OKF v0.2 domain types

export type OkfStatus = "draft" | "stable" | "deprecated";

export interface OkfSource {
  id: string;
  resource?: string;
  title?: string;
  author?: string;
  last_modified?: string;
  usage_count?: number;
}

export interface OkfVerification {
  by: string;
  at: string;
  attester?: string;
}

export interface OkfProvenance {
  by: string;
  at: string;
}

export interface OkfFrontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  generated?: OkfProvenance;
  verified?: OkfVerification[];
  status?: OkfStatus;
  stale_after?: string;
  sources?: OkfSource[];
  [key: string]: unknown;
}

export interface OkfValidationIssue {
  field: string;
  severity: "error" | "warning";
  message: string;
}
