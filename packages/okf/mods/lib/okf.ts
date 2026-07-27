import { parse as parseYaml } from "yaml";
import type {
  OkfFrontmatter,
  OkfProvenance,
  OkfSource,
  OkfStatus,
  OkfValidationIssue,
  OkfVerification,
} from "../types.ts";

// ── Frontmatter extraction ──

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/;

export function extractFrontmatter(content: string): { raw: string; parsed: Record<string, unknown> } | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const raw = match[1];
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  } catch {
    return null;
  }

  return { raw, parsed };
}

export function isOkfConcept(fm: Record<string, unknown>): fm is Record<string, unknown> & { type: string } {
  return typeof fm.type === "string" && fm.type.length > 0;
}

export function asOkfFrontmatter(fm: Record<string, unknown>): OkfFrontmatter {
  return fm as unknown as OkfFrontmatter;
}

// ── Validation ──

const VALID_STATUSES: ReadonlySet<string> = new Set(["draft", "stable", "deprecated"]);

export function validateOkfFrontmatter(fm: OkfFrontmatter, isWrite: boolean): OkfValidationIssue[] {
  const issues: OkfValidationIssue[] = [];

  // Provenance: agent writes should populate `generated`
  if (isWrite && !fm.generated) {
    issues.push({
      field: "generated",
      severity: "warning",
      message: "OKF concept is missing `generated` provenance. Auto-populated by okf-trust mod.",
    });
  }

  // Provenance: validate structure when present
  if (fm.generated) {
    validateProvenance(fm.generated, issues);
  }

  // Verification: validate structure
  if (fm.verified) {
    if (!Array.isArray(fm.verified)) {
      issues.push({
        field: "verified",
        severity: "error",
        message: "`verified` must be an array of { by, at } objects.",
      });
    } else {
      for (const v of fm.verified) {
        validateVerification(v, issues);
      }
    }
  }

  // Status
  if (fm.status !== undefined) {
    if (typeof fm.status !== "string" || !VALID_STATUSES.has(fm.status)) {
      issues.push({
        field: "status",
        severity: "error",
        message: `Invalid status "${String(fm.status)}". Must be one of: draft, stable, deprecated.`,
      });
    }
  }

  // Staleness
  if (fm.stale_after) {
    validateStaleness(fm.stale_after, fm.status, issues);
  }

  // Sources
  if (fm.sources) {
    if (!Array.isArray(fm.sources)) {
      issues.push({
        field: "sources",
        severity: "error",
        message: "`sources` must be an array of objects.",
      });
    } else {
      for (const s of fm.sources) {
        validateSource(s, issues);
      }
    }
  }

  return issues;
}

function validateProvenance(prov: OkfProvenance, issues: OkfValidationIssue[]): void {
  if (typeof prov.by !== "string" || !prov.by) {
    issues.push({ field: "generated.by", severity: "error", message: "`generated.by` must be a non-empty string." });
  }
  if (typeof prov.at !== "string" || !prov.at) {
    issues.push({ field: "generated.at", severity: "error", message: "`generated.at` must be an ISO-8601 timestamp." });
  }
}

function validateVerification(v: OkfVerification, issues: OkfValidationIssue[]): void {
  if (typeof v.by !== "string" || !v.by) {
    issues.push({ field: "verified[].by", severity: "error", message: "Each `verified` entry must have a non-empty `by` field." });
  }
  if (typeof v.at !== "string" || !v.at) {
    issues.push({ field: "verified[].at", severity: "error", message: "Each `verified` entry must have an ISO-8601 `at` timestamp." });
  }
}

function validateStaleness(staleAfter: string, status: OkfStatus | undefined, issues: OkfValidationIssue[]): void {
  const stale = new Date(staleAfter);
  if (isNaN(stale.getTime())) {
    issues.push({ field: "stale_after", severity: "error", message: "`stale_after` must be a valid ISO-8601 date." });
    return;
  }
  if (stale < new Date() && status !== "deprecated") {
    issues.push({
      field: "stale_after",
      severity: "warning",
      message: `Concept is past its stale_after date (${staleAfter}). Consider updating or marking as deprecated.`,
    });
  }
}

function validateSource(s: OkfSource, issues: OkfValidationIssue[]): void {
  if (typeof s !== "object" || !s) {
    issues.push({ field: "sources[]", severity: "error", message: "Each `sources` entry must be an object." });
    return;
  }
  if (typeof s.id !== "string" || !s.id) {
    issues.push({ field: "sources[].id", severity: "error", message: "Each `sources` entry must have a non-empty `id`." });
  }
}

// ── Provenance generation ──

export function generateProvenance(agentId: string | undefined): OkfProvenance {
  return {
    by: agentId ?? "unknown",
    at: new Date().toISOString(),
  };
}

// ── Content manipulation ──

export function setFrontmatterField(
  content: string,
  field: string,
  value: unknown,
): string {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return content;

  const raw = match[1];
  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(raw) as Record<string, unknown>;
    if (!fm || typeof fm !== "object") return content;
  } catch {
    return content;
  }

  // We can't easily YAML-render the value inline without a full re-serialize.
  // Instead, check if the field already exists with a simple key match,
  // and replace the line. Otherwise, append after the last frontmatter line.

  const lines = raw.split("\n");
  const fieldKey = `${field}:`;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(fieldKey)) {
      lines[i] = `${field}: ${JSON.stringify(value)}`;
      const newFm = lines.join("\n");
      return content.replace(FRONTMATTER_RE, `---\n${newFm}\n---`);
    }
  }

  // Append
  const newFm = raw + `\n${field}: ${JSON.stringify(value)}`;
  return content.replace(FRONTMATTER_RE, `---\n${newFm}\n---`);
}

// ── Tool name matchers ──

const MEMFS_WRITE_TOOLS = new Set(["memory", "Write", "Edit"]);

export function isMemfsWrite(toolName: string): boolean {
  return MEMFS_WRITE_TOOLS.has(toolName);
}

export function extractTextArg(args: Record<string, unknown>): string | null {
  // memory tool: { command, file_text, new_string, ... }
  if (typeof args.file_text === "string") return args.file_text;
  if (typeof args.new_string === "string") return args.new_string;
  // Write tool: { file_path, content }
  if (typeof args.content === "string") return args.content;
  // Edit tool: { file_path, new_string, old_string }
  if (typeof args.new_string === "string") return args.new_string;
  return null;
}

export function extractFilePath(args: Record<string, unknown>): string | null {
  if (typeof args.file_path === "string") return args.file_path;
  return null;
}

// MemFS paths live under the agent's memory directory.
// We look for the pattern: .../memfs/<agent-id>/memory/...
export function isMemoryPath(filePath: string): boolean {
  return filePath.includes("/memfs/") && filePath.includes("/memory/");
}
