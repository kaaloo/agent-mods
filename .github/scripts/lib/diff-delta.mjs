// Delta computation for the inline reviewer. Given a previously
// reviewed commit SHA and a current head SHA, fetch the per-file
// diff between the two via the GitHub Compare API and build a map
// of path -> Set<line> of right-side line numbers that changed.
//
// The main script then uses this map to filter the PR diff down to
// only hunks touching changed lines, so unchanged content does not
// get re-reviewed on every push (see issue #14).
//
// Why the Compare API and not `git diff`
// --------------------------------------
// The workflow checks out the PR head with the default fetch-depth
// (1), so the prior commit is not in the local history. Using the
// GitHub API keeps this helper pure and avoids adding a fetch step
// to the workflow just for delta computation.
//
// Error handling
// --------------
// If the prior SHA is not reachable from the head (force-push, or
// the marker refers to a commit that has since been rewritten), the
// Compare API returns 404 with a "Not Found" message. We surface
// this as a typed result so the caller can fall back to a full
// review.

import { parsePatchAnchors } from './github-anchors.mjs';

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Fetch the right-side changed lines between two SHAs.
 *
 * @param {object} args
 * @param {string} args.repository - "owner/repo"
 * @param {string} args.baseSha - prior reviewed SHA
 * @param {string} args.headSha - current head SHA
 * @param {(endpoint: string, opts?: object) => string} args.ghApi
 * @returns {Promise<DeltaResult>}
 *
 * DeltaResult:
 *   { ok: true,  changedLines: Map<path, Set<line>>, removedFiles: Set<path>, renamedFiles: Map<newPath, oldPath> }
 *   { ok: false, reason: 'sha-not-reachable' | 'sha-unknown' | 'compare-failed' }
 */
export async function fetchChangedLinesSince({ repository, baseSha, headSha, ghApi }) {
  if (!SHA_RE.test(baseSha) || !SHA_RE.test(headSha)) {
    return { ok: false, reason: 'sha-unknown' };
  }

  let payload;
  try {
    payload = JSON.parse(
      ghApi(`repos/${repository}/compare/${baseSha.toLowerCase()}...${headSha.toLowerCase()}`),
    );
  } catch (err) {
    // ghApi propagates stderr; we cannot easily distinguish 404 from
    // other failures. The compare endpoint returns a "Not Found"
    // body when the base is not reachable from head, so try to
    // parse stderr too.
    const message = err?.message ?? String(err);
    if (/Not Found/i.test(message) || /404/.test(message)) {
      return { ok: false, reason: 'sha-not-reachable' };
    }
    return { ok: false, reason: 'compare-failed' };
  }

  if (!payload || !Array.isArray(payload.files)) {
    return { ok: false, reason: 'compare-failed' };
  }

  const changedLines = new Map();
  const removedFiles = new Set();
  const renamedFiles = new Map();
  for (const f of payload.files) {
    if (typeof f?.filename !== 'string') continue;
    if (f.status === 'removed') {
      removedFiles.add(f.filename);
      continue;
    }
    if (f.status === 'renamed' && typeof f.previous_filename === 'string') {
      renamedFiles.set(f.filename, f.previous_filename);
    }
    // For added / modified / renamed files, use the per-file patch
    // to derive the right-side line numbers that changed. The
    // Compare API's per-file `patch` field is a unified diff
    // without a `diff --git` header; we wrap it with one so
    // parsePatchAnchors can parse the hunk lines.
    const patch = typeof f.patch === 'string' ? f.patch : '';
    if (!patch) {
      // If the API omitted the patch (binary, large diff), treat
      // the file as fully changed so the model can still review it
      // and the anchor validator can keep its hunk set.
      changedLines.set(f.filename, null);
      continue;
    }
    const wrapped = `diff --git a/${f.filename} b/${f.filename}\n${patch}`;
    const anchors = parsePatchAnchors(wrapped);
    const rightSet = anchors.right.get(f.filename);
    if (rightSet && rightSet.size > 0) {
      changedLines.set(f.filename, rightSet);
    } else if (f.status === 'added') {
      // Newly-added files always have content on the right side.
      // parsePatchAnchors should have populated the right map; if
      // it didn't, fall back to marking the file fully changed.
      changedLines.set(f.filename, null);
    }
  }

  return { ok: true, changedLines, removedFiles, renamedFiles };
}

// A `null` map value means "every right-side line in the file is
// in scope" (e.g. the file is new or the API omitted the patch).
// The filter uses this to skip per-line intersection.

/**
 * Filter a PR diff to only hunks whose right-side lines intersect
 * with the changed-lines map. Hunks with no overlap are dropped.
 *
 * If `changedLines` is empty (the prior SHA matches the head and
 * nothing changed), the result is an empty diff string. Callers
 * detect that and post a "no new findings" comment instead of
 * re-running the model.
 *
 * Deleted files in the changedLines set are excluded entirely from
 * the filtered patch — there are no right-side lines to anchor
 * against, and we don't want the reviewer to re-flag deletions that
 * the author already acknowledged.
 *
 * The function preserves the diff preamble (everything before the
 * first `diff --git ` boundary), which is empty for the PR-diff
 * accept header but kept for safety.
 */
export function filterPatchToChangedLines(patch, changedLines, { removedFiles = new Set() } = {}) {
  if (!patch || !patch.trim()) return '';
  if (!changedLines || (changedLines instanceof Map && changedLines.size === 0)) {
    return '';
  }

  const blocks = patch.split(/^diff --git /m);
  const preamble = blocks[0] ?? '';
  const kept = [preamble];

  for (const block of blocks.slice(1)) {
    const headerLines = block.split('\n');
    const newPath = extractNewPathFromHeader(headerLines[0] ?? '');
    if (!newPath) {
      // Could not parse the path; keep the block untouched so we
      // never silently drop content the reviewer might need.
      kept.push(`diff --git ${block}`);
      continue;
    }

    if (removedFiles.has(newPath)) {
      // File was removed in the delta; there is no right-side
      // content. Skip the whole block — the reviewer should not
      // re-flag it.
      continue;
    }

    const changed = changedLines.get(newPath);
    if (changed === undefined) {
      // File unchanged since last review. Drop it from the
      // reviewer's input. Note: a `null` map value means
      // "whole file is in scope" and is handled below.
      continue;
    }

    if (changed === null) {
      // Treat every hunk as in-scope; keep the block as-is.
      kept.push(`diff --git ${block}`);
      continue;
    }

    // Walk hunks and keep only those whose right-side lines
    // intersect the changed set. Drop the file header from the
    // output if no hunks survive.
    const filtered = filterBlocksKeepingChangedHunks(block, newPath, changed);
    if (filtered) kept.push(`diff --git ${filtered}`);
  }

  return kept.join('');
}

function filterBlocksKeepingChangedHunks(block, newPath, changed) {
  // The block has the form:
  //   a/<path> b/<path>
  //   <metadata lines...>
  //   @@ ... @@
  //   <hunk lines...>
  //   @@ ... @@
  //   <hunk lines...>
  // We walk line-by-line so we can preserve hunk headers and
  // drop only the hunk bodies whose right-side lines are all
  // unchanged. The caller is responsible for re-prepending the
  // `diff --git ` boundary. We preserve the trailing newline so
  // consecutive blocks don't run together when concatenated.
  const trailingNewline = block.endsWith('\n');
  const lines = block.split('\n');
  // The split leaves an empty trailing element when the block ends
  // with \n. Drop it so we can rebuild the body cleanly.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const headerEnd = findFirstHunkIndex(lines);
  if (headerEnd === -1) {
    // No hunks in this block (rare: pure rename, mode change).
    // Keep the block as-is; caller will prepend the diff boundary.
    return block;
  }

  const header = lines.slice(0, headerEnd);
  const hunks = [];
  let current = null;

  for (let i = headerEnd; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      current = { header: line, body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) hunks.push(current);

  const kept = [];
  for (const hunk of hunks) {
    if (hunkIntersects(hunk, changed)) {
      kept.push(hunk.header);
      kept.push(...hunk.body);
    }
  }
  if (kept.length === 0) return null;

  const out = [...header, ...kept].join('\n');
  return trailingNewline ? `${out}\n` : out;
}

function hunkIntersects(hunk, changed) {
  const header = parseHunkHeader(hunk.header);
  if (!header) return true; // conservative: keep malformed hunks
  let rightLine = header.newStart;
  for (const bodyLine of hunk.body) {
    if (bodyLine.startsWith('+') || bodyLine.startsWith(' ')) {
      if (changed.has(rightLine)) return true;
      rightLine += 1;
    } else if (bodyLine.startsWith('-')) {
      // Deletion-only line; doesn't advance right-side.
    } else if (bodyLine.startsWith('\\')) {
      // "\ No newline at end of file" - skip
    } else {
      // Blank or other; ignore.
    }
  }
  return false;
}

function parseHunkHeader(line) {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function findFirstHunkIndex(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('@@')) return i;
  }
  return -1;
}

// Minimal path extractor for the diff header. Mirrors the
// relevant subset of github-anchors.mjs so the behavior is
// consistent with the anchor parser. Handles both the
// `a/<path> b/<path>` form (whole diff) and the post-split
// `<path> b/<path>` form (block-level, after `diff --git `
// has been peeled off).
function extractNewPathFromHeader(headerLine) {
  const quoted = headerLine.match(/^"((?:\\.|[^"])*)"\s+"((?:\\.|[^"])*)"$/);
  if (quoted) {
    return stripABPrefix(decodeGitQuotedPath(quoted[2]));
  }
  if (headerLine.includes('\t')) {
    const parts = headerLine.split('\t');
    if (parts.length >= 2) {
      return stripABPrefix(parts[1].trim());
    }
  }
  const match = headerLine.match(/^a?\/(.+?) b\/(.+)$/);
  if (match) return stripABPrefix(match[2]);
  return null;
}

function stripABPrefix(p) {
  return p.startsWith('b/') ? p.slice(2) : p;
}

function decodeGitQuotedPath(path) {
  const escapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\x0b' };
  return path.replace(/\\(.)/g, (_, c) => escapes[c] ?? c);
}

// Exported for tests.
export const __test__ = {
  hunkIntersects,
  filterBlocksKeepingChangedHunks,
  extractNewPathFromHeader,
};
