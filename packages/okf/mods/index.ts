import type { LettaModContext, LettaEvent, LettaEventHandlerContext, PermissionEvent } from "./types.ts";
import {
  extractFrontmatter,
  isOkfConcept,
  asOkfFrontmatter,
  validateOkfFrontmatter,
  generateProvenance,
  isMemfsWrite,
  extractTextArg,
  extractFilePath,
  isMemoryPath,
  reconstructEditResult,
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

          const filePath = extractFilePath(event.args);
          // For Write/Edit tools, check if target is a memory path
          if (event.toolName !== "memory" && filePath && !isMemoryPath(filePath)) return;

          // For Edit operations, reconstruct the post-edit document so we
          // validate the full content (not just the new_string fragment which
          // has no frontmatter delimiters).
          let text: string | null;
          if (event.toolName === "Edit" && typeof event.args.old_string === "string" && typeof event.args.new_string === "string" && filePath) {
            text = reconstructEditResult(filePath, event.args.old_string, event.args.new_string);
          } else {
            text = extractTextArg(event.args);
          }
          if (!text) return;

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

          // Surface warnings so the agent can correct them on the next write
          const warnings = issues.filter((i) => i.severity === "warning");
          if (warnings.length > 0) {
            return {
              decision: "allow",
              reason: `OKF trust warnings:\n${warnings.map((w) => `  - ${w.field}: ${w.message}`).join("\n")}`,
            };
          }

          return;
        },
      }),
    );
  }

  // ── tool_end handler: surface provenance warnings on successful writes ──
  if (letta.capabilities?.events?.tools) {
    disposers.push(
      letta.events.on("tool_end", (event: LettaEvent, _ctx: LettaEventHandlerContext) => {
        if (event.status !== "success") return;
        if (!isMemfsWrite(event.toolName ?? "")) return;

        const args = event.args ?? {};
        const filePath = extractFilePath(args as Record<string, unknown>);
        if (event.toolName !== "memory" && filePath && !isMemoryPath(filePath)) return;

        // For Edit operations, reconstruct the post-edit document
        let text: string | null;
        if (event.toolName === "Edit" && typeof (args as Record<string, unknown>).old_string === "string" && typeof (args as Record<string, unknown>).new_string === "string" && filePath) {
          text = reconstructEditResult(filePath, (args as Record<string, unknown>).old_string as string, (args as Record<string, unknown>).new_string as string);
        } else {
          text = extractTextArg(args as Record<string, unknown>);
        }
        if (!text) return;

        const extraction = extractFrontmatter(text);
        if (!extraction) return;
        if (!isOkfConcept(extraction.parsed)) return;

        const fm = asOkfFrontmatter(extraction.parsed);

        // Don't overwrite existing provenance
        if (fm.generated) return;

        const provenance = generateProvenance(event.agentId ?? undefined);
        // Annotate the tool result so the agent sees the missing-provenance
        // warning and knows to include `generated` on the next write.
        const output = String(event.output ?? "");
        const warning = `\n\n[okf] Missing ` + "`generated`" + ` provenance. Auto-populated with { by: "${provenance.by}", at: "${provenance.at}" } on next write.`;
        return { result: { status: "success", output: output + warning } };
      }),
    );
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
