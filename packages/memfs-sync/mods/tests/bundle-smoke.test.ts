import { describe, expect, it, vi } from "vitest";
// @ts-expect-error the committed JavaScript bundle has no declaration file
import activate from "../index.bundled.mjs";
import type { MemfsSyncModContext, ModCommand } from "../types.ts";

describe("committed memfs-sync bundle", () => {
	it("registers its handlers and command, and disposes them", async () => {
		const events: string[] = [];
		let command: ModCommand | undefined;
		const dispose = vi.fn(() => {});
		const context: MemfsSyncModContext = {
			capabilities: {
				commands: true,
				events: { turns: true, tools: false, lifecycle: false },
			},
			events: {
				on: (event: string) => {
					events.push(event);
					return dispose;
				},
			},
			commands: {
				register: (registered: ModCommand) => {
					command = registered;
					return dispose;
				},
			},
		};

		const cleanup = activate(context);
		// Only turn_start may trigger a sync: no tool or lifecycle hook may overlap
		// a rebase or checkout reset.
		expect(events).toEqual(["turn_start"]);
		expect(command?.id).toBe("memfs-sync");

		const saved = { ...process.env };
		delete process.env.MEMORY_DIR;
		delete process.env.LETTA_MEMORY_DIR;
		try {
			const result = await command?.run({ memfs: { enabled: false } });
			expect(result).toEqual({
				type: "output",
				output: "memfs-sync: MemFS is not enabled.",
			});
		} finally {
			process.env = saved;
		}

		cleanup();
		expect(dispose).toHaveBeenCalledTimes(2);
	});

	it("registers nothing when no capability is available", () => {
		const on = vi.fn(() => () => {});
		activate({ events: { on } });
		expect(on).not.toHaveBeenCalled();
	});
});
