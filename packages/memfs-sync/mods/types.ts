// Minimal typings for the Letta Code mod runtime surface this mod uses.

export interface ModCallbackContext {
	cwd?: string;
	args?: string;
	agent?: { id?: string | null; name?: string | null };
	memfs?: { enabled?: boolean; memoryDir?: string | null };
	[key: string]: unknown;
}

export interface ModEvent {
	agentId?: string | null;
	conversationId?: string | null;
	toolName?: string;
	status?: string;
	[key: string]: unknown;
}

export type CommandResult = { type: "output"; output: string };

export interface ModCommand {
	id: string;
	description: string;
	args?: string;
	run(ctx: ModCallbackContext): CommandResult | Promise<CommandResult>;
}

export interface MemfsSyncModContext {
	capabilities?: {
		commands?: boolean;
		ui?: { panels?: boolean };
		events?: { turns?: boolean; tools?: boolean; lifecycle?: boolean };
	};
	events: {
		on: (
			event: string,
			handler: (event: ModEvent, ctx: ModCallbackContext) => unknown,
		) => () => void;
	};
	commands?: { register: (command: ModCommand) => () => void };
	ui?: { notify?: (message: string) => void };
}
