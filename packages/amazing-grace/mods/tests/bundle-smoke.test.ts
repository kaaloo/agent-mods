import { describe, expect, it } from "vitest";
// @ts-expect-error the committed JavaScript bundle has no declaration file
import activate from "../index.bundled.mjs";
import type { LettaModContext, ModCommandRegistration } from "../types.ts";

describe("committed amazing-grace bundle", () => {
	it("registers the command and lifecycle event handlers", () => {
		const events: string[] = [];
		let command: ModCommandRegistration | undefined;
		const dispose = () => {};
		const context = {
			capabilities: {
				tools: false,
				commands: true,
				events: {
					lifecycle: true,
					tools: true,
					turns: true,
					compact: false,
					llm: false,
				},
				permissions: false,
				providers: false,
				ui: { panels: false },
			},
			commands: {
				register: (registration: ModCommandRegistration) => {
					command = registration;
					return dispose;
				},
			},
			events: {
				on: (event: string) => {
					events.push(event);
					return dispose;
				},
			},
			diagnostics: { report: () => {} },
		} as unknown as LettaModContext;

		const disposeMod = activate(context);
		expect(disposeMod).toBeTypeOf("function");
		expect(command?.id).toBe("amazing-grace");
		expect(events).toEqual(
			expect.arrayContaining([
				"conversation_open",
				"turn_start",
				"turn_end",
				"tool_end",
			]),
		);
		disposeMod();
	});
});
