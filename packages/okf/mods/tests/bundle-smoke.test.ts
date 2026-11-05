import { describe, expect, it, vi } from "vitest";
// @ts-expect-error the committed JavaScript bundle has no declaration file
import activate from "../index.bundled.mjs";
import type {
	LettaModContext,
	PermissionEvent,
	PermissionOverlay,
} from "../types.ts";

describe("committed OKF bundle", () => {
	it("activates and enforces a real permission decision", () => {
		let overlay: PermissionOverlay | undefined;
		const events: string[] = [];
		const dispose = vi.fn(() => {});
		const context = {
			capabilities: {
				permissions: true,
				events: { tools: true },
			},
			permissions: {
				register: (permission: PermissionOverlay) => {
					overlay = permission;
					return dispose;
				},
			},
			events: {
				on: (event: string) => {
					events.push(event);
					return dispose;
				},
			},
		} as unknown as LettaModContext;

		const disposeMod = activate(context);
		expect(disposeMod).toBeTypeOf("function");
		expect(overlay?.id).toBe("okf-trust");
		expect(events).toEqual(["tool_end"]);
		if (!overlay) throw new Error("OKF permission overlay was not registered");

		const decision = overlay.check({
			toolName: "Write",
			args: {
				file_path: "/memfs/agent-test/memory/example.md",
				content:
					'---\ntype: BigQuery Table\ngenerated: { by: "", at: "2026-01-01" }\n---\n',
			},
		} as unknown as PermissionEvent);
		expect(decision?.decision).toBe("deny");

		disposeMod();
		expect(dispose).toHaveBeenCalledTimes(2);
	});
});
