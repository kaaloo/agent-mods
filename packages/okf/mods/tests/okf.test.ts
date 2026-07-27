import { describe, it, expect } from "vitest";
import {
  extractFrontmatter,
  isOkfConcept,
  validateOkfFrontmatter,
  generateProvenance,
  setFrontmatterField,
  isMemfsWrite,
  isMemoryPath,
} from "../lib/okf.ts";
import type { OkfFrontmatter } from "../types.ts";

const okfOrdersTable = `---
type: BigQuery Table
title: Customer Orders
description: One row per completed order
resource: https://bigquery.googleapis.com/v2/projects/acme/datasets/sales/tables/orders
tags: [sales, orders, revenue]
generated: { by: reference_agent/gemini-2.5-pro, at: "2026-06-30T14:00:00Z" }
verified:
  - { by: "human:kliu@acme", at: "2026-07-01T16:00:00Z" }
status: stable
stale_after: "2026-12-31"
sources:
  - id: warehouse-schema
    resource: https://wiki.acme.internal/data/warehouse
    title: Acme Retail warehouse schema
    author: team:data-platform
    last_modified: "2026-06-15"
---

# Schema

| Column | Type | Description |
|--------|------|-------------|
| order_id | STRING | Globally unique order id |
`;

describe("extractFrontmatter", () => {
  it("extracts YAML frontmatter from markdown", () => {
    const result = extractFrontmatter(okfOrdersTable);
    expect(result).not.toBeNull();
    expect(result!.parsed.type).toBe("BigQuery Table");
    expect(result!.parsed.title).toBe("Customer Orders");
    expect(result!.parsed.status).toBe("stable");
  });

  it("returns null for content without frontmatter", () => {
    const result = extractFrontmatter("# Just a heading\n\nSome text");
    expect(result).toBeNull();
  });

  it("returns null for invalid YAML", () => {
    const result = extractFrontmatter("---\n{[invalid\n---\n\nbody");
    expect(result).toBeNull();
  });

  it("returns null for non-object YAML", () => {
    const result = extractFrontmatter("---\n- just a list\n---\n\nbody");
    expect(result).toBeNull();
  });
});

describe("isOkfConcept", () => {
  it("returns true when type field is present", () => {
    expect(isOkfConcept({ type: "Metric" })).toBe(true);
  });

  it("returns false when type field is absent", () => {
    expect(isOkfConcept({ title: "Something" })).toBe(false);
  });

  it("returns false when type is empty string", () => {
    expect(isOkfConcept({ type: "" })).toBe(false);
  });
});

describe("validateOkfFrontmatter", () => {
  const validFm: OkfFrontmatter = {
    type: "Metric",
    title: "Revenue",
    generated: { by: "agent/test", at: "2026-07-01T00:00:00Z" },
    verified: [{ by: "human:alice@acme", at: "2026-07-02T00:00:00Z" }],
    status: "stable",
    stale_after: "2027-01-01",
    sources: [{ id: "warehouse-schema", title: "Schema", author: "team:data" }],
  };

  it("passes a fully valid concept with no issues", () => {
    const issues = validateOkfFrontmatter(validFm, true);
    expect(issues).toEqual([]);
  });

  it("warns when generated is missing on write", () => {
    const fm = { ...validFm, generated: undefined };
    const issues = validateOkfFrontmatter(fm, true);
    expect(issues).toHaveLength(1);
    expect(issues[0].field).toBe("generated");
    expect(issues[0].severity).toBe("warning");
  });

  it("does not warn about missing generated on read (isWrite=false)", () => {
    const fm = { ...validFm, generated: undefined };
    const issues = validateOkfFrontmatter(fm, false);
    expect(issues).toEqual([]);
  });

  it("errors on invalid generated.by", () => {
    const fm: OkfFrontmatter = {
      type: "Metric",
      generated: { by: "", at: "2026-07-01T00:00:00Z" },
    };
    const issues = validateOkfFrontmatter(fm, true);
    const error = issues.find((i) => i.field === "generated.by" && i.severity === "error");
    expect(error).toBeDefined();
    expect(error!.message).toContain("non-empty");
  });

  it("errors on invalid generated.at", () => {
    const fm: OkfFrontmatter = {
      type: "Metric",
      generated: { by: "agent/test", at: "" },
    };
    const issues = validateOkfFrontmatter(fm, true);
    const error = issues.find((i) => i.field === "generated.at" && i.severity === "error");
    expect(error).toBeDefined();
  });

  it("errors when verified is not an array", () => {
    const fm: OkfFrontmatter = {
      type: "Metric",
      verified: "not-an-array" as unknown as OkfFrontmatter["verified"],
    };
    const issues = validateOkfFrontmatter(fm, true);
    const error = issues.find((i) => i.field === "verified" && i.severity === "error");
    expect(error).toBeDefined();
  });

  it("errors on invalid verified entry", () => {
    const fm: OkfFrontmatter = {
      type: "Metric",
      verified: [{ by: "", at: "2026-07-01T00:00:00Z" }],
    };
    const issues = validateOkfFrontmatter(fm, true);
    const error = issues.find((i) => i.field === "verified[].by");
    expect(error).toBeDefined();
  });

  it("errors on invalid status", () => {
    const fm: OkfFrontmatter = { type: "Metric", status: "invalid" as OkfFrontmatter["status"] };
    const issues = validateOkfFrontmatter(fm, true);
    const error = issues.find((i) => i.field === "status" && i.severity === "error");
    expect(error).toBeDefined();
  });

  it("warns when stale_after is in the past and status is not deprecated", () => {
    const fm: OkfFrontmatter = {
      type: "Metric",
      stale_after: "2020-01-01",
      status: "stable",
    };
    const issues = validateOkfFrontmatter(fm, true);
    const warning = issues.find((i) => i.field === "stale_after" && i.severity === "warning");
    expect(warning).toBeDefined();
  });

  it("does not warn when stale_after is in the past but status is deprecated", () => {
    const fm: OkfFrontmatter = {
      type: "Metric",
      stale_after: "2020-01-01",
      status: "deprecated",
    };
    const issues = validateOkfFrontmatter(fm, true);
    const warning = issues.find((i) => i.field === "stale_after" && i.severity === "warning");
    expect(warning).toBeUndefined();
  });

  it("errors when sources is not an array", () => {
    const fm: OkfFrontmatter = {
      type: "Metric",
      sources: "not-an-array" as unknown as OkfFrontmatter["sources"],
    };
    const issues = validateOkfFrontmatter(fm, true);
    const error = issues.find((i) => i.field === "sources" && i.severity === "error");
    expect(error).toBeDefined();
  });

  it("errors when a source entry lacks an id", () => {
    const fm: OkfFrontmatter = {
      type: "Metric",
      sources: [{ title: "No ID" }] as OkfFrontmatter["sources"],
    };
    const issues = validateOkfFrontmatter(fm, true);
    const error = issues.find((i) => i.field === "sources[].id" && i.severity === "error");
    expect(error).toBeDefined();
  });

  it("does not error on valid, minimal OKF concept (just type)", () => {
    const fm: OkfFrontmatter = { type: "Metric" };
    const issues = validateOkfFrontmatter(fm, false);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });
});

describe("generateProvenance", () => {
  it("generates provenance with agent id and timestamp", () => {
    const prov = generateProvenance("agent-test-123");
    expect(prov.by).toBe("agent-test-123");
    expect(prov.at).toBeTruthy();
    expect(() => new Date(prov.at)).not.toThrow();
  });

  it("falls back to 'unknown' when agentId is undefined", () => {
    const prov = generateProvenance(undefined);
    expect(prov.by).toBe("unknown");
  });
});

describe("setFrontmatterField", () => {
  it("replaces an existing field", () => {
    const result = setFrontmatterField(okfOrdersTable, "status", "deprecated");
    const fm = extractFrontmatter(result);
    expect(fm!.parsed.status).toBe("deprecated");
  });

  it("appends a new field", () => {
    const result = setFrontmatterField(okfOrdersTable, "freshness_check", "2026-08-01");
    const fm = extractFrontmatter(result);
    expect(fm!.parsed.freshness_check).toBe("2026-08-01");
  });

  it("returns original content when no frontmatter exists", () => {
    const content = "# No frontmatter";
    const result = setFrontmatterField(content, "status", "stable");
    expect(result).toBe(content);
  });
});

describe("isMemfsWrite", () => {
  it("matches memory tool", () => expect(isMemfsWrite("memory")).toBe(true));
  it("matches Write tool", () => expect(isMemfsWrite("Write")).toBe(true));
  it("matches Edit tool", () => expect(isMemfsWrite("Edit")).toBe(true));
  it("does not match Read tool", () => expect(isMemfsWrite("Read")).toBe(false));
  it("does not match Bash tool", () => expect(isMemfsWrite("Bash")).toBe(false));
});

describe("isMemoryPath", () => {
  it("matches Letta memfs paths", () => {
    expect(isMemoryPath("/Users/luis/.letta/memfs/agent-123/memory/system/human.md")).toBe(true);
  });

  it("rejects non-memory paths", () => {
    expect(isMemoryPath("/Users/luis/Code/something.md")).toBe(false);
    expect(isMemoryPath("/Users/luis/.letta/other/file.txt")).toBe(false);
  });
});
