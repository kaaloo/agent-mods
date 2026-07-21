// Per-PR state for the inline reviewer. The reviewer writes a hidden
// marker into a PR issue comment so subsequent pushes can compute a
// delta against the previously reviewed commit. Without this state,
// every push re-runs a full review against the entire PR diff, which
// re-fires line-anchored findings on lines the author already
// acknowledged (see issue #14 for the original motivation).
//
// Storage format
// --------------
// One issue comment per PR whose body starts with:
//
//   <!-- letta-inline-review:state -->
//   <!-- letta-inline-review:last-reviewed-sha=<40-hex> -->
//   <!-- letta-inline-review:head-sha-at-review=<40-hex> -->
//
// The hidden markers are machine-read. The visible body is a small
// summary table for humans (last reviewed commit, head SHA compared,
// timestamp).
//
// Why an issue comment and not an artifact / PR body trailer
// --------------------------------------------------------
// - Issue comments survive re-runs and re-pushes without a custom
//   artifact lifecycle step.
// - The PR body is author-managed; mutating it can collide with the
//   author's edits and change PR appearance.
// - Issue comments require only `pull-requests: write`, which the
//   job already has.
//
// Marker comment IDs are returned by loadLastReviewedSha so the
// caller can update (PATCH) the same comment on subsequent runs
// instead of accumulating one stale marker per push.

const MARKER_PREFIX = '<!-- letta-inline-review:';
const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Look up the most recent marker comment authored by the
 * letta-actions bot (or whoever is running this script with the
 * current GITHUB_TOKEN) on a PR. Returns the SHA stored in the
 * marker plus the comment ID, or null if no marker exists.
 *
 * `ghApi` is injected so the helper stays easy to unit-test.
 *
 * Notes on trust
 * --------------
 * Any PR commenter can craft a comment whose body looks like a
 * marker. We do not validate the comment author here because the
 * marker only encodes an optimization: a forged marker pointing
 * at the current head SHA would just trigger the "no lines
 * changed" path, which is equivalent to a full review with the
 * acked-anchor filter. The blast radius is bounded. If the
 * repository ever needs hard guarantee, callers can filter
 * `comments` by `c.user.login === expectedBot` before this
 * helper runs.
 */
export async function loadLastReviewedSha({ repository, pullNumber, ghApi }) {
  const comments = JSON.parse(
    ghApi(`repos/${repository}/issues/${pullNumber}/comments?per_page=100`),
  );
  if (!Array.isArray(comments)) return null;

  // GitHub returns issue comments in ascending order by default;
  // sort by created_at descending so we pick the latest marker if
  // a previous run left a stale one without an exact-id match.
  const sorted = [...comments].sort((a, b) => {
    const at = Date.parse(a?.created_at ?? '') || 0;
    const bt = Date.parse(b?.created_at ?? '') || 0;
    return bt - at;
  });

  for (const c of sorted) {
    if (typeof c?.body !== 'string') continue;
    const sha = parseLastReviewedSha(c.body);
    if (sha) return { sha, commentId: c.id };
  }
  return null;
}

/**
 * Create or update the PR's marker comment with the SHA of the
 * commit that was just reviewed.
 *
 * If a marker comment already exists, update its body in place. If
 * not, create a new one. Returns the resulting comment ID.
 */
export async function recordLastReviewedSha({
  repository,
  pullNumber,
  headSha,
  reviewedSha,
  ghApi,
}) {
  if (!SHA_RE.test(headSha) || !SHA_RE.test(reviewedSha)) {
    throw new Error('headSha and reviewedSha must be 40-char hex strings.');
  }
  const body = renderMarkerBody({ headSha, reviewedSha });

  const existing = await loadLastReviewedSha({ repository, pullNumber, ghApi });
  if (existing) {
    ghApi(`repos/${repository}/issues/comments/${existing.commentId}`, {
      method: 'PATCH',
      body: { body },
    });
    return { commentId: existing.commentId, created: false };
  }

  const created = JSON.parse(
    ghApi(`repos/${repository}/issues/${pullNumber}/comments`, {
      method: 'POST',
      body: { body },
    }),
  );
  return { commentId: created.id, created: true };
}

function renderMarkerBody({ headSha, reviewedSha }) {
  const isoNow = new Date().toISOString();
  const reviewedShort = reviewedSha.slice(0, 7);
  const headShort = headSha.slice(0, 7);
  return [
    '<!-- letta-inline-review:state -->',
    `<!-- letta-inline-review:last-reviewed-sha=${reviewedSha.toLowerCase()} -->`,
    `<!-- letta-inline-review:head-sha-at-review=${headSha.toLowerCase()} -->`,
    '',
    '<sub>',
    'Letta Code inline-review state tracker. Do not edit: this comment is read by future review runs to compute the diff delta against the previously reviewed commit.',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Last reviewed SHA | \`${reviewedShort}\` |`,
    `| Head SHA at review | \`${headShort}\` |`,
    `| Updated | ${isoNow} |`,
    '</sub>',
  ].join('\n');
}

function parseLastReviewedSha(body) {
  if (!body || !body.includes(MARKER_PREFIX)) return null;
  // Require the state-marker preamble so we don't pick up an
  // accidental substring match on a human-written comment.
  if (!body.includes('letta-inline-review:state')) return null;
  const match = body.match(/letta-inline-review:last-reviewed-sha=([0-9a-f]{40})/i);
  if (!match) return null;
  const sha = match[1].toLowerCase();
  return SHA_RE.test(sha) ? sha : null;
}

// Exported for tests. Not used by the main script.
export const __test__ = { parseLastReviewedSha, renderMarkerBody, SHA_RE };
