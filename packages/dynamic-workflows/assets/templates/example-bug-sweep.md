---
name: example-bug-sweep
version: "1"
description: Example workflow that scans a codebase for common bug categories and synthesizes findings.
phases:
  - id: scan
    type: fan-out
    concurrency: 3
    agents:
      - id: race
        prompt: Scan the codebase for concurrency bugs such as race conditions, deadlocks, unsynchronized shared state, and missing locks. Return a structured list of file paths, line numbers, severity, and a short explanation for each finding.
      - id: "null"
        prompt: Scan the codebase for null or undefined dereference risks such as unchecked optional values, unchecked return values, and missing error handling. Return a structured list of file paths, line numbers, severity, and a short explanation for each finding.
      - id: inject
        prompt: Scan the codebase for injection vectors such as SQL injection, command injection, unsafe eval, unvalidated user input used in paths or commands, and missing input sanitization. Return a structured list of file paths, line numbers, severity, and a short explanation for each finding.
  - id: synthesize
    type: barrier
    depends_on:
      - scan
    prompt: Merge the findings from the race, null, and injection scans into a single prioritized report. Group by severity, deduplicate overlapping issues, and provide actionable next steps.
budgets:
  max_concurrent: 3
  max_duration_ms: 600000
---

This example workflow demonstrates the fan-out/barrier pattern. The first phase dispatches three parallel specialist scans. Once all three complete, the barrier phase synthesizes their findings into a single prioritized report.
