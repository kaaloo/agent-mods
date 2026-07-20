// Parses a unified diff into a set of valid (path, line) anchors for
// inline PR review comments. A comment anchored to a line that does
// not appear in the diff will be rejected by GitHub's pull request
// review API with a 422, so we pre-validate anchors here and drop
// invalid ones before posting.
//
// The parser handles the conventional "diff --git a/... b/..." format
// produced by `git diff` and the GitHub PR diff endpoint, including
// "new file mode", "deleted file mode", rename headers, and quoted
// paths such as `"a/file name.txt" "b/file name.txt"`.

/**
 * Build a map of path -> Set<line_number> of valid RIGHT-side anchors
 * (i.e. lines present in the PR's new file), and a parallel map of
 * path -> Set<line_number> of valid LEFT-side anchors (lines present
 * in the base file that are still visible in the diff).
 *
 * @param {string} patch - The unified diff body.
 * @returns {{right: Map<string, Set<number>>, left: Map<string, Set<number>>}}
 */
export function parsePatchAnchors(patch) {
  const right = new Map();
  const left = new Map();

  if (!patch) return { right, left };

  // Split on "diff --git " boundaries. We process each file block.
  const blocks = patch.split(/^diff --git /m).slice(1);
  for (const block of blocks) {
    const headerLines = block.split('\n');
    // First header line: "a/<path> b/<path>" - may contain spaces if
    // filenames contain spaces; the conventional separator is the
    // longest "\t" or " " boundary that produces two distinct paths.
    const firstLine = headerLines[0] ?? '';
    const newPath = extractBPath(firstLine);
    if (!newPath) continue;

    // Deleted files have no RIGHT anchors (the file does not exist
    // on the PR side), but their LEFT anchors are still meaningful.
    const isDeleted = /^deleted file mode/m.test(block);

    const rightAnchors = new Set();
    const leftAnchors = new Set();

    let rightLine = 0;
    let leftLine = 0;
    let inHunk = false;
    for (const line of headerLines.slice(1)) {
      if (line.startsWith('@@')) {
        const hunk = parseHunkHeader(line);
        if (!hunk) {
          inHunk = false;
          continue;
        }
        inHunk = true;
        rightLine = hunk.newStart;
        leftLine = hunk.oldStart;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith('+')) {
        rightAnchors.add(rightLine);
        rightLine += 1;
      } else if (line.startsWith('-')) {
        leftAnchors.add(leftLine);
        leftLine += 1;
      } else if (line.startsWith(' ')) {
        rightAnchors.add(rightLine);
        leftAnchors.add(leftLine);
        rightLine += 1;
        leftLine += 1;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" - skip
        continue;
      } else {
        inHunk = false;
      }
    }

    if (!isDeleted && rightAnchors.size > 0) {
      right.set(newPath, merge(right.get(newPath), rightAnchors));
    }
    if (leftAnchors.size > 0) {
      left.set(newPath, merge(left.get(newPath), leftAnchors));
    }
  }

  return { right, left };
}

function extractBPath(headerLine) {
  // headerLine is "a/<path> b/<path>" or with quoted paths
  // (e.g. when filenames contain spaces).
  const quoted = parseQuotedDiffHeader(headerLine);
  if (quoted) return quoted.newPath;

  if (headerLine.includes('\t')) {
    const parts = headerLine.split('\t');
    if (parts.length >= 2) {
      return stripABPrefix(unquoteGitPath(parts[1].trim()));
    }
  }
  // Fall back: split on " b/" separator if present.
  const match = headerLine.match(/^a\/(.+?) b\/(.+)$/);
  if (match) return match[2];
  return null;
}

function parseQuotedDiffHeader(headerLine) {
  if (!headerLine.startsWith('"')) return null;
  const paths = [];
  let current = '';
  let escaped = false;
  let inQuote = false;
  for (const ch of headerLine) {
    if (!inQuote) {
      if (ch === '"') inQuote = true;
      continue;
    }
    if (escaped) {
      current += decodeGitPathEscape(ch);
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      paths.push(current);
      current = '';
      inQuote = false;
      continue;
    }
    current += ch;
  }
  if (paths.length < 2) return null;
  return { oldPath: stripABPrefix(paths[0]), newPath: stripABPrefix(paths[1]) };
}

function unquoteGitPath(path) {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  return parseQuotedDiffHeader(`${path} ${path}`)?.newPath ?? path.slice(1, -1);
}

function decodeGitPathEscape(ch) {
  // Git quotes common C-style escapes in diff headers. Preserve
  // unknown escapes as the escaped character, matching Git's visible
  // path semantics closely enough for GitHub anchor validation.
  if (ch === 't') return '\t';
  if (ch === 'n') return '\n';
  if (ch === 'r') return '\r';
  return ch;
}

function stripABPrefix(p) {
  return p.startsWith('b/') ? p.slice(2) : p;
}

function parseHunkHeader(line) {
  // "@@ -oldStart,oldCount +newStart,newCount @@" (counts default to 1)
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function merge(existing, additions) {
  if (!existing) return additions;
  for (const v of additions) existing.add(v);
  return existing;
}
