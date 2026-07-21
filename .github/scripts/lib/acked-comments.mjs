// Line-aware filter for already-acknowledged review findings. When
// the inline-review job runs in a state where the prior-SHA delta
// is not available (first push, or a force-push that orphaned the
// marker), we fall back to running a full review. To avoid
// re-emitting the same line-anchored noise the author already
// replied to, this helper pulls the PR's existing review comments
// and builds a set of (path, line, side) anchors that a human has
// already acknowledged.
//
// Acknowledgement rule
// --------------------
// A finding is "acked" iff:
//   - the corresponding review thread has at least one reply
//     authored by one of the configured `ackers`, AND
//   - `ackers` is supplied by the caller. By convention, callers
//     pass the PR author plus the repo owner (the union of
//     accounts whose replies should silence a re-fire).
//
// Bot replies alone do not count: the original Letta Code review
// is itself a bot comment, and the reviewer's earlier line is not
// an acknowledgement. We only suppress re-fires after a human
// actually responded.
//
// We deliberately do not require a literal "Closing" or "RESOLVED"
// marker; that puts the burden on humans to follow a convention.
// The presence of any human reply in the thread is sufficient.

/**
 * Fetch the set of (path, line, side) anchors that have been
 * acknowledged on the PR by one of the configured ackers.
 *
 * @param {object} args
 * @param {string} args.repository
 * @param {number} args.pullNumber
 * @param {(endpoint: string, opts?: object) => string} args.ghApi
 * @param {string[]} args.ackers - GitHub usernames whose replies
 *   count as acknowledgement. Required; the caller decides who
 *   counts as a human acker (PR author, repo owner, etc.).
 * @returns {Promise<{acked: Set<string>, comments: number}>}
 */
export async function loadAckedAnchors({ repository, pullNumber, ghApi, ackers }) {
  if (!Array.isArray(ackers) || ackers.length === 0) {
    return { acked: new Set(), comments: 0 };
  }
  const normalizedAckers = new Set(ackers.map((a) => String(a).toLowerCase()));
  // /pulls/{n}/comments returns the inline review comments and
  // their threaded replies. Each entry has `in_reply_to_id`
  // pointing to its parent (or null for the root comment).
  const comments = JSON.parse(
    ghApi(`repos/${repository}/pulls/${pullNumber}/comments?per_page=100`),
  );
  if (!Array.isArray(comments)) return { acked: new Set(), comments: 0 };

  // Build a thread-id -> anchor map for root comments.
  const roots = new Map();
  for (const c of comments) {
    if (c?.in_reply_to_id) continue;
    if (typeof c?.path !== 'string' || typeof c?.line !== 'number') continue;
    const key = anchorKey(c.path, c.line, normalizeSide(c.side));
    roots.set(c.id, { key, author: c.user?.login ?? '' });
  }

  // Find threads with a reply from a human acker.
  const acked = new Set();
  for (const c of comments) {
    if (!c?.in_reply_to_id) continue;
    const login = c.user?.login ?? '';
    if (!normalizedAckers.has(login.toLowerCase())) continue;
    const root = roots.get(c.in_reply_to_id);
    if (root) acked.add(root.key);
  }

  return { acked, comments: comments.length };
}

/**
 * Filter findings by dropping any whose (path, line, side) is
 * already in the acked set. Returns the kept list plus a parallel
 * list of dropped entries with a reason string for logging.
 */
export function dropAckedFindings(findings, acked) {
  if (!acked || acked.size === 0) return { kept: [...findings], dropped: [] };
  const kept = [];
  const dropped = [];
  for (const f of findings) {
    const key = anchorKey(f.path, f.line, normalizeSide(f.side));
    if (acked.has(key)) {
      dropped.push({ ...f, reason: `Line ${f.line} (${f.side}) already acknowledged on ${f.path}` });
    } else {
      kept.push(f);
    }
  }
  return { kept, dropped };
}

function anchorKey(path, line, side) {
  return `${path}\x00${side}\x00${line}`;
}

function normalizeSide(value) {
  if (value === undefined) return 'RIGHT';
  if (typeof value !== 'string') return 'RIGHT';
  const normalized = value.toUpperCase();
  return normalized === 'LEFT' || normalized === 'RIGHT' ? normalized : 'RIGHT';
}

// Exported for tests.
export const __test__ = { anchorKey, normalizeSide };
