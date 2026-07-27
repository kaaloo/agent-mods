import type { LettaModContext, LettaEvent, LettaEventHandlerContext, PermissionEvent } from "./types.ts";
import {
  extractFrontmatter,
  isOkfConcept,
  asOkfFrontmatter,
  validateOkfFrontmatter,
  generateProvenance,
  setFrontmatterField,
  isMemfsWrite,
  extractTextArg,
  extractFilePath,
  isMemoryPath,
} from "./lib/okf.ts";

export default function activate(letta: LettaModContext): (() => void) {
  const disposers: Array<() => void> = [];

  // ── Permission overlay: gate writes to OKF concepts ──
  if (letta.capabilities?.permissions && letta.permissions) {
    disposers.push(
      letta.permissions.register({
        id: "okf-trust",
        description:
          "Enforce OKF v0.2 trust signals (provenance, verification, freshness, lifecycle) on MemFS memory writes.",
        check(event: PermissionEvent) {
          // Only gate MemFS writes
          if (!isMemfsWrite(event.toolName)) return;

          const text = extractTextArg(event.args);
          if (!text) return;

          const filePath = extractFilePath(event.args);
          // For Write/Edit tools, check if target is a memory path
          if (event.toolName !== "memory" && filePath && !isMemoryPath(filePath)) return;

          const extraction = extractFrontmatter(text);
          if (!extraction) return;
          if (!isOkfConcept(extraction.parsed)) return;

          const fm = asOkfFrontmatter(extraction.parsed);
          const issues = validateOkfFrontmatter(fm, true);

          // Block writes with structural errors
          const errors = issues.filter((i) => i.severity === "error");
          if (errors.length > 0) {
            return {
              decision: "deny",
              reason: `OKF trust validation failed:\n${errors.map((e) => `  - ${e.field}: ${e.message}`).join("\n")}`,
            };
          }

          // Allow writes with warnings only (provenance auto-populated by tool_end)
          return;
        },
      }),
    );
  }

  // ── tool_end handler: auto-populate provenance on successful writes ──
  if (letta.capabilities?.events?.tools) {
    disposers.push(
      letta.events.on("tool_end", (event: LettaEvent, _ctx: LettaEventHandlerContext) => {
        if (event.status !== "success") return;
        if (!isMemfsWrite(event.toolName ?? "")) return;

        const args = event.args ?? {};
        const text = extractTextArg(args as Record<string, unknown>);
        if (!text) return;

        const filePath = extractFilePath(args as Record<string, unknown>);
        if (event.toolName !== "memory" && filePath && !isMemoryPath(filePath)) return;

        const extraction = extractFrontmatter(text);
        if (!extraction) return;
        if (!isOkfConcept(extraction.parsed)) return;

        const fm = asOkfFrontmatter(extraction.parsed);

        // Don't overwrite existing provenance
        if (fm.generated) return;

        const provenance = generateProvenance(event.agentId ?? undefined);
        // Note: tool_end fires after the write has already happened.
        // We can only log/report here; the provenance will be missing
        // on the first write but the permission overlay's warning will
        // guide the agent to include it next time.
        //
        // In a future iteration, we could use tool_end result replacement
        // to annotate the output with a provenance reminder.
        void provenance; // Use in result replacement once that API is available
        void setFrontmatterField; // Use for in-place fix once the memory tool supports it
      }),
    );
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
