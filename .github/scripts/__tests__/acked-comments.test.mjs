// Tests for lib/acked-comments.mjs. Verifies that line-anchored
// findings get filtered out when a human has already replied to
// the same anchor on the PR, and that bot-only threads do not
// count as acknowledgement.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadAckedAnchors, dropAckedFindings } from '../lib/acked-comments.mjs';

function makeRoot({ id, path, line, side = 'RIGHT', login = 'github-actions[bot]' }) {
  return { id, in_reply_to_id: null, path, line, side, user: { login } };
}

function makeReply({ id, in_reply_to_id, login }) {
  return { id, in_reply_to_id, user: { login } };
}

test('loadAckedAnchors returns empty set when there are no comments', async () => {
  const fakeGhApi = () => JSON.stringify([]);
  const result = await loadAckedAnchors({
    repository: 'o/r',
    pullNumber: 1,
    ghApi: fakeGhApi,
    ackers: ['kaaloo'],
  });
  assert.equal(result.acked.size, 0);
  assert.equal(result.comments, 0);
});

test('loadAckedAnchors treats a human reply as an acknowledgement', async () => {
  const fakeGhApi = () =>
    JSON.stringify([
      makeRoot({ id: 1, path: 'a.ts', line: 10 }),
      makeReply({ id: 2, in_reply_to_id: 1, login: 'kaaloo' }),
    ]);
  const { acked } = await loadAckedAnchors({
    repository: 'o/r',
    pullNumber: 1,
    ghApi: fakeGhApi,
    ackers: ['kaaloo'],
  });
  assert.equal(acked.size, 1);
  assert.ok(acked.has('a.ts\x00RIGHT\x0010'));
});

test('loadAckedAnchors does not treat bot-only threads as acked', async () => {
  const fakeGhApi = () =>
    JSON.stringify([
      makeRoot({ id: 1, path: 'a.ts', line: 10 }),
      makeReply({ id: 2, in_reply_to_id: 1, login: 'github-actions[bot]' }),
    ]);
  const { acked } = await loadAckedAnchors({
    repository: 'o/r',
    pullNumber: 1,
    ghApi: fakeGhApi,
    ackers: ['kaaloo'],
  });
  assert.equal(acked.size, 0);
});

test('loadAckedAnchors only counts replies from configured ackers', async () => {
  const fakeGhApi = () =>
    JSON.stringify([
      makeRoot({ id: 1, path: 'a.ts', line: 10 }),
      makeReply({ id: 2, in_reply_to_id: 1, login: 'random-reviewer' }),
    ]);
  const { acked } = await loadAckedAnchors({
    repository: 'o/r',
    pullNumber: 1,
    ghApi: fakeGhApi,
    ackers: ['kaaloo'],
  });
  assert.equal(acked.size, 0);
});

test('loadAckedAnchors recognizes multiple configured ackers', async () => {
  const fakeGhApi = () =>
    JSON.stringify([
      makeRoot({ id: 1, path: 'a.ts', line: 10 }),
      makeReply({ id: 2, in_reply_to_id: 1, login: 'pr-author' }),
    ]);
  const { acked } = await loadAckedAnchors({
    repository: 'o/r',
    pullNumber: 1,
    ghApi: fakeGhApi,
    ackers: ['kaaloo', 'pr-author'],
  });
  assert.equal(acked.size, 1, 'PR author replies should also count');
});

test('loadAckedAnchors requires an ackers list', async () => {
  const fakeGhApi = () =>
    JSON.stringify([
      makeRoot({ id: 1, path: 'a.ts', line: 10 }),
      makeReply({ id: 2, in_reply_to_id: 1, login: 'kaaloo' }),
    ]);
  const { acked } = await loadAckedAnchors({
    repository: 'o/r',
    pullNumber: 1,
    ghApi: fakeGhApi,
  });
  assert.equal(acked.size, 0, 'without ackers, nothing should be marked acked');
});

test('loadAckedAnchors tolerates a non-array response', async () => {
  const fakeGhApi = () => JSON.stringify({ unexpected: 'shape' });
  const { acked, comments } = await loadAckedAnchors({
    repository: 'o/r',
    pullNumber: 1,
    ghApi: fakeGhApi,
    ackers: ['kaaloo'],
  });
  assert.equal(acked.size, 0);
  assert.equal(comments, 0);
});

test('dropAckedFindings drops findings whose anchor is acked', () => {
  const findings = [
    { path: 'a.ts', line: 10, side: 'RIGHT', title: 'A' },
    { path: 'a.ts', line: 20, side: 'RIGHT', title: 'B' },
    { path: 'b.ts', line: 5, side: 'RIGHT', title: 'C' },
  ];
  const acked = new Set(['a.ts\x00RIGHT\x0010']);
  const { kept, dropped } = dropAckedFindings(findings, acked);
  assert.equal(kept.length, 2);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].title, 'A');
  assert.match(dropped[0].reason, /already acknowledged/);
});

test('dropAckedFindings distinguishes LEFT vs RIGHT anchors', () => {
  const findings = [
    { path: 'a.ts', line: 10, side: 'LEFT', title: 'deleted-line' },
  ];
  const acked = new Set(['a.ts\x00RIGHT\x0010']);
  const { kept } = dropAckedFindings(findings, acked);
  assert.equal(kept.length, 1, 'LEFT-side finding should not match a RIGHT-side acked anchor');
});

test('dropAckedFindings with empty set returns all findings as kept', () => {
  const findings = [{ path: 'a.ts', line: 10, side: 'RIGHT', title: 'A' }];
  const { kept, dropped } = dropAckedFindings(findings, new Set());
  assert.deepEqual(kept, findings);
  assert.deepEqual(dropped, []);
});
