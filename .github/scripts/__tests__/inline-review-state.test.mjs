// Tests for lib/inline-review-state.mjs. Verifies the marker
// format roundtrips through the parser, malformed bodies are
// rejected, and upsert delegates to PATCH when an existing
// marker is present and POST otherwise.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadLastReviewedSha,
  recordLastReviewedSha,
  __test__,
} from '../lib/inline-review-state.mjs';

const SHA = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

test('renderMarkerBody produces parseable body', () => {
  const body = __test__.renderMarkerBody({ headSha: HEAD, reviewedSha: SHA });
  const parsed = __test__.parseLastReviewedSha(body);
  assert.equal(parsed, SHA.toLowerCase());
});

test('parseLastReviewedSha requires the state preamble', () => {
  // Same SHA token but no preamble → reject, so we never match an
  // accidental substring on a human-written comment.
  const body = `<!-- letta-inline-review:last-reviewed-sha=${SHA} -->`;
  assert.equal(__test__.parseLastReviewedSha(body), null);
});

test('parseLastReviewedSha rejects malformed SHAs', () => {
  const body = [
    '<!-- letta-inline-review:state -->',
    '<!-- letta-inline-review:last-reviewed-sha=zzz -->',
  ].join('\n');
  assert.equal(__test__.parseLastReviewedSha(body), null);
});

test('parseLastReviewedSha handles missing input', () => {
  assert.equal(__test__.parseLastReviewedSha(''), null);
  assert.equal(__test__.parseLastReviewedSha(null), null);
  assert.equal(__test__.parseLastReviewedSha(undefined), null);
});

test('loadLastReviewedSha returns the latest marker comment id', async () => {
  const older = {
    id: 1,
    created_at: '2026-07-20T10:00:00Z',
    body: [
      '<!-- letta-inline-review:state -->',
      `<!-- letta-inline-review:last-reviewed-sha=${'c'.repeat(40)} -->`,
    ].join('\n'),
  };
  const newer = {
    id: 2,
    created_at: '2026-07-21T10:00:00Z',
    body: [
      '<!-- letta-inline-review:state -->',
      `<!-- letta-inline-review:last-reviewed-sha=${SHA} -->`,
    ].join('\n'),
  };
  // GitHub returns comments in ascending order by default. We
  // must pick the newer one even though it comes last.
  const fakeGhApi = () => JSON.stringify([older, newer]);
  const result = await loadLastReviewedSha({
    repository: 'o/r',
    pullNumber: 1,
    ghApi: fakeGhApi,
  });
  assert.deepEqual(result, { sha: SHA, commentId: 2 });
});

test('loadLastReviewedSha handles missing created_at defensively', async () => {
  // Without timestamps, the comparator is ambiguous; the helper
  // should still return a marker rather than failing. We just
  // verify it returns *some* valid marker.
  const noTimestamps = [
    {
      id: 1,
      body: [
        '<!-- letta-inline-review:state -->',
        `<!-- letta-inline-review:last-reviewed-sha=${'c'.repeat(40)} -->`,
      ].join('\n'),
    },
    {
      id: 2,
      body: [
        '<!-- letta-inline-review:state -->',
        `<!-- letta-inline-review:last-reviewed-sha=${SHA} -->`,
      ].join('\n'),
    },
  ];
  const fakeGhApi = () => JSON.stringify(noTimestamps);
  const result = await loadLastReviewedSha({
    repository: 'o/r',
    pullNumber: 1,
    ghApi: fakeGhApi,
  });
  assert.ok(result, 'should still return a marker');
  assert.ok([1, 2].includes(result.commentId), 'one of the two markers is picked');
});

test('loadLastReviewedSha ignores non-marker comments', async () => {
  const fakeGhApi = () =>
    JSON.stringify([
      { id: 10, body: 'Random comment without any marker.' },
      { id: 11, body: '<!-- letta-inline-review:last-reviewed-sha=notvalid -->' },
    ]);
  const result = await loadLastReviewedSha({
    repository: 'o/r',
    pullNumber: 1,
    ghApi: fakeGhApi,
  });
  assert.equal(result, null);
});

test('recordLastReviewedSha PATCHes an existing marker', async () => {
  const calls = [];
  const fakeGhApi = (endpoint, opts = {}) => {
    calls.push({ endpoint, method: opts.method ?? 'GET' });
    if (endpoint.includes('/comments?per_page=')) {
      return JSON.stringify([
        {
          id: 99,
          body: [
            '<!-- letta-inline-review:state -->',
            `<!-- letta-inline-review:last-reviewed-sha=${'d'.repeat(40)} -->`,
          ].join('\n'),
        },
      ]);
    }
    if (opts.method === 'PATCH') {
      return JSON.stringify({ id: 99 });
    }
    if (opts.method === 'POST') {
      return JSON.stringify({ id: 100 });
    }
    return '{}';
  };
  const result = await recordLastReviewedSha({
    repository: 'o/r',
    pullNumber: 1,
    headSha: HEAD,
    reviewedSha: SHA,
    ghApi: fakeGhApi,
  });
  assert.deepEqual(result, { commentId: 99, created: false });
  const patchCall = calls.find((c) => c.method === 'PATCH');
  assert.ok(patchCall, 'should PATCH the existing marker');
  assert.equal(patchCall.endpoint, 'repos/o/r/issues/comments/99');
});

test('recordLastReviewedSha POSTs a new marker when none exists', async () => {
  const calls = [];
  const fakeGhApi = (endpoint, opts = {}) => {
    calls.push({ endpoint, method: opts.method ?? 'GET' });
    if (endpoint.includes('/comments?per_page=')) return JSON.stringify([]);
    if (opts.method === 'POST') {
      return JSON.stringify({ id: 42 });
    }
    return '{}';
  };
  const result = await recordLastReviewedSha({
    repository: 'o/r',
    pullNumber: 1,
    headSha: HEAD,
    reviewedSha: SHA,
    ghApi: fakeGhApi,
  });
  assert.deepEqual(result, { commentId: 42, created: true });
  const postCall = calls.find((c) => c.method === 'POST');
  assert.ok(postCall);
  assert.equal(postCall.endpoint, 'repos/o/r/issues/1/comments');
});

test('recordLastReviewedSha rejects malformed SHAs', async () => {
  await assert.rejects(
    recordLastReviewedSha({
      repository: 'o/r',
      pullNumber: 1,
      headSha: HEAD,
      reviewedSha: 'not-a-sha',
      ghApi: () => '{}',
    }),
    /40-char hex/,
  );
});
