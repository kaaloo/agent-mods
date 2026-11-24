import { describeOutcome, MemfsSync, type SyncOutcome } from "./lib/sync.ts";
import type { MemfsSyncModContext, ModCallbackContext } from "./types.ts";

/** Tools whose successful run can create a commit in the memory checkout. */
const COMMIT_CAPABLE_TOOLS = new Set([
	"Bash",
	"Shell",
	"memory",
	"ShellCommand",
]);

export function memoryDirFromContext(
	ctx: ModCallbackContext | undefined,
): string | null {
	const memfs = ctx?.memfs;
	if (memfs && memfs.enabled !== false && typeof memfs.memoryDir === "string") {
		return memfs.memoryDir || null;
	}
	const fromEnv = process.env.MEMORY_DIR || process.env.LETTA_MEMORY_DIR;
	return fromEnv || null;
}

export default function activate(letta: MemfsSyncModContext): () => void {
	const disposers: Array<() => void> = [];
	const syncers = new Map<string, MemfsSync>();
	const lastHeads = new Map<string, string | null>();

	const syncerFor = (dir: string): MemfsSync => {
		let syncer = syncers.get(dir);
		if (!syncer) {
			syncer = new MemfsSync(dir);
			syncers.set(dir, syncer);
		}
		return syncer;
	};

	const report = (outcome: SyncOutcome) => {
		const message = describeOutcome(outcome);
		if (!message) return;
		if (letta.capabilities?.ui?.panels && letta.ui?.notify) {
			letta.ui.notify(message);
		} else if (outcome.status === "error") {
			console.warn(message);
		}
	};

	const runSync = async (dir: string): Promise<SyncOutcome> => {
		const syncer = syncerFor(dir);
		const outcome = await syncer.sync();
		lastHeads.set(dir, await syncer.head());
		report(outcome);
		return outcome;
	};

	/** Sync only when HEAD moved since we last looked (a new local commit). */
	const syncIfHeadMoved = async (dir: string): Promise<void> => {
		const head = await syncerFor(dir).head();
		if (lastHeads.has(dir) && lastHeads.get(dir) === head) return;
		await runSync(dir);
	};

	if (letta.capabilities?.events?.turns) {
		// Pull before the model sees memory. Never cancel or rewrite the turn: a
		// failed sync is reported and the turn proceeds on the local checkout.
		disposers.push(
			letta.events.on("turn_start", async (_event, ctx) => {
				const dir = memoryDirFromContext(ctx);
				if (dir) await runSync(dir);
			}),
		);
	}

	if (letta.capabilities?.events?.lifecycle) {
		disposers.push(
			letta.events.on("conversation_open", (_event, ctx) => {
				const dir = memoryDirFromContext(ctx);
				if (dir) void runSync(dir);
			}),
		);
	}

	if (letta.capabilities?.events?.tools) {
		// Push memory commits as soon as the tool that made them finishes. Runs in
		// the background so the tool result is not delayed by network round-trips.
		disposers.push(
			letta.events.on("tool_end", (event, ctx) => {
				if (event.status !== "success") return;
				if (!COMMIT_CAPABLE_TOOLS.has(event.toolName ?? "")) return;
				const dir = memoryDirFromContext(ctx);
				if (dir) void syncIfHeadMoved(dir);
			}),
		);
	}

	if (letta.capabilities?.commands && letta.commands) {
		disposers.push(
			letta.commands.register({
				id: "memfs-sync",
				description:
					"Sync the memory checkout with its shared repository (or `status`)",
				args: "[status]",
				async run(ctx) {
					const dir = memoryDirFromContext(ctx);
					if (!dir) {
						return {
							type: "output",
							output: "memfs-sync: MemFS is not enabled.",
						};
					}
					const syncer = syncerFor(dir);
					if ((ctx.args ?? "").trim() === "status") {
						const cfg = await syncer.loadConfig();
						const last = syncer.lastOutcome
							? `${syncer.lastRunAt?.toISOString()} ${JSON.stringify(syncer.lastOutcome)}`
							: "no sync yet in this session";
						return {
							type: "output",
							output: [
								`memfs-sync: ${dir}`,
								`  enabled: ${cfg.enabled}  remote: ${cfg.remote}/${cfg.branch}  sign: ${cfg.sign}`,
								`  index command: ${cfg.indexCommand ?? "(none)"}`,
								`  last: ${last}`,
							].join("\n"),
						};
					}
					const outcome = await syncer.sync();
					lastHeads.set(dir, await syncer.head());
					return {
						type: "output",
						output:
							describeOutcome(outcome) ??
							`memfs-sync: ${outcome.status}${"reason" in outcome ? ` (${outcome.reason})` : ""}.`,
					};
				},
			}),
		);
	}

	return () => {
		for (const dispose of disposers.reverse()) dispose();
	};
}
