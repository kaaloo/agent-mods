// Tests for lib/diff-delta.mjs. Verifies the delta filter keeps
// only hunks whose right-side lines intersect the changed-line set,
// and handles edge cases (empty diffs, removed files, malformed
// headers).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchChangedLinesSince,
  filterPatchToChangedLines,
  __test__,
} from '../lib/diff-delta.mjs';
import { parsePatchAnchors } from '../lib/github-anchors.mjs';

const HEAD = 'b'.repeat(40);
const BASE = 'a'.repeat(40);

function buildComparePayload({ files }) {
  return JSON.stringify({ files });
}

// A minimal two-hunk patch for `pkg/a.ts` (lines 1-4 and 12-14) and
// `pkg/b.ts` (single hunk lines 1-3). Used as a stable fixture
// across multiple test cases.
const SAMPLE_PR_PATCH = [
  'diff --git a/pkg/a.ts b/pkg/a.ts',
  'index 1111111..2222222 100644',
  '--- a/pkg/a.ts',
  '+++ b/pkg/a.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  '+added2',
  '-removed2',
  ' line3',
  '+added4',
  '@@ -10,2 +12,3 @@',
  ' line12',
  '+added13',
  ' line14',
  'diff --git a/pkg/b.ts b/pkg/b.ts',
  'index 3333333..4444444 100644',
  '--- a/pkg/b.ts',
  '+++ b/pkg/b.ts',
  '@@ -1,2 +1,3 @@',
  ' b1',
  '+b2',
  ' b3',
].join('\n');

test('filterPatchToChangedLines keeps only hunks whose right-side lines changed', () => {
  // Changed lines: pkg/a.ts adds lines 2 and 4; pkg/b.ts adds line 2.
  const changedLines = new Map([
    ['pkg/a.ts', new Set([2, 4])],
    ['pkg/b.ts', new Set([2])],
  ]);

  const filtered = filterPatchToChangedLines(SAMPLE_PR_PATCH, changedLines);

  const anchors = parsePatchAnchors(filtered);
  // pkg/a.ts: first hunk touches right lines 1,2,3,4 — intersects {2,4} ✓
  //           second hunk touches 12,13,14 — none changed → drop
  // pkg/b.ts: hunk touches 1,2,3 — intersects {2} ✓
  assert.deepEqual([...anchors.right.get('pkg/a.ts')].sort(), [1, 2, 3, 4]);
  assert.deepEqual([...anchors.right.get('pkg/b.ts')].sort(), [1, 2, 3]);
});

test('filterPatchToChangedLines drops files with no changed lines', () => {
  const changedLines = new Map([
    ['pkg/a.ts', new Set([2])],
  ]);
  const filtered = filterPatchToChangedLines(SAMPLE_PR_PATCH, changedLines);
  assert.ok(!filtered.includes('pkg/b.ts'), 'pkg/b.ts should be dropped');
  assert.ok(filtered.includes('pkg/a.ts'));
});

test('filterPatchToChangedLines treats null map value as whole-file change', () => {
  const changedLines = new Map([
    ['pkg/b.ts', null],
  ]);
  const filtered = filterPatchToChangedLines(SAMPLE_PR_PATCH, changedLines);
  assert.ok(filtered.includes('pkg/b.ts'), 'null entry should keep the whole file');
  assert.ok(!filtered.includes('pkg/a.ts'), 'absent entry should drop the file');
});

test('filterPatchToChangedLines returns empty for empty diff', () => {
  assert.equal(filterPatchToChangedLines('', new Map([['pkg/a.ts', new Set([1])]])), '');
  assert.equal(filterPatchToChangedLines('   \n  ', new Map([['pkg/a.ts', new Set([1])]])), '');
});

test('filterPatchToChangedLines returns empty when no files changed', () => {
  const filtered = filterPatchToChangedLines(SAMPLE_PR_PATCH, new Map());
  assert.equal(filtered, '');
});

test('filterPatchToChangedLines excludes removedFiles from output', () => {
  const changedLines = new Map([
    ['pkg/a.ts', new Set([2])],
  ]);
  const removedFiles = new Set(['pkg/b.ts']);
  const filtered = filterPatchToChangedLines(SAMPLE_PR_PATCH, changedLines, { removedFiles });
  assert.ok(!filtered.includes('pkg/b.ts'), 'removed file should be excluded');
  assert.ok(filtered.includes('pkg/a.ts'));
});

test('hunkIntersects: returns true when any right-side line is in changed set', () => {
  const hunk = {
    header: '@@ -1,3 +1,4 @@',
    body: [
      ' line1',
      '+added2',
      ' line3',
      '+added4',
    ],
  };
  assert.equal(__test__.hunkIntersects(hunk, new Set([4])), true);
  assert.equal(__test__.hunkIntersects(hunk, new Set([100])), false);
});

test('hunkIntersects: ignores deletion-only lines', () => {
  // Header says oldStart=1, oldCount=3 (3 lines in old), newStart=1,
  // newCount=2 (2 lines in new). Body:
  //   ' line1'   → context, right advances 1→2
  //   '-removed' → deletion, no right advance
  //   ' line2'   → context, right advances 2→3
  // Wait: newCount=2 says only 2 lines in new. The body has
  // 1 context + 1 deletion + 1 context = 2 right lines. Right lines: 1, 2.
  const hunk = {
    header: '@@ -1,3 +1,2 @@',
    body: [
      ' line1',
      '-removed',
      ' line2',
    ],
  };
  assert.equal(__test__.hunkIntersects(hunk, new Set([1])), true);
  assert.equal(__test__.hunkIntersects(hunk, new Set([2])), true);
  // Set {3} doesn't intersect; right line 3 doesn't exist in this hunk.
  assert.equal(__test__.hunkIntersects(hunk, new Set([3])), false);
});

test('fetchChangedLinesSince returns typed failure for non-reachable SHA', async () => {
  const fakeGhApi = (endpoint) => {
    if (endpoint.includes('/compare/')) {
      throw new Error('HTTP 404 Not Found');
    }
    return '{}';
  };
  const result = await fetchChangedLinesSince({
    repository: 'o/r',
    baseSha: BASE,
    headSha: HEAD,
    ghApi: fakeGhApi,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sha-not-reachable');
});

test('fetchChangedLinesSince rejects malformed SHAs', async () => {
  const result = await fetchChangedLinesSince({
    repository: 'o/r',
    baseSha: 'not-a-sha',
    headSha: HEAD,
    ghApi: () => '{}',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sha-unknown');
});

test('fetchChangedLinesSince builds a per-file map from compare payload', async () => {
  const fakeGhApi = (endpoint) => {
    if (endpoint.includes('/compare/')) {
      return buildComparePayload({
        files: [
          {
            filename: 'pkg/a.ts',
            status: 'modified',
            patch: [
              '@@ -1,3 +1,4 @@',
              ' line1',
              '+added2',
              ' line3',
              ' line4',
            ].join('\n'),
          },
          {
            filename: 'pkg/removed.ts',
            status: 'removed',
            patch: '',
          },
          {
            filename: 'pkg/binary.png',
            status: 'modified',
            // No patch → treated as fully changed
          },
        ],
      });
    }
    return '{}';
  };
  const result = await fetchChangedLinesSince({
    repository: 'o/r',
    baseSha: BASE,
    headSha: HEAD,
    ghApi: fakeGhApi,
  });
  assert.equal(result.ok, true);
  assert.deepEqual([...result.changedLines.get('pkg/a.ts')].sort(), [1, 2, 3, 4]);
  assert.equal(result.changedLines.get('pkg/binary.png'), null);
  assert.ok(!result.changedLines.has('pkg/removed.ts'));
  assert.ok(result.removedFiles.has('pkg/removed.ts'));
});

test('fetchChangedLinesSince handles rename status', async () => {
  const fakeGhApi = (endpoint) => {
    if (endpoint.includes('/compare/')) {
      return buildComparePayload({
        files: [
          {
            filename: 'new/path.ts',
            previous_filename: 'old/path.ts',
            status: 'renamed',
            patch: [
              '@@ -1,2 +1,3 @@',
              ' a',
              '+b',
              ' c',
            ].join('\n'),
          },
        ],
      });
    }
    return '{}';
  };
  const result = await fetchChangedLinesSince({
    repository: 'o/r',
    baseSha: BASE,
    headSha: HEAD,
    ghApi: fakeGhApi,
  });
  assert.equal(result.ok, true);
  assert.deepEqual([...result.changedLines.get('new/path.ts')].sort(), [1, 2, 3]);
  assert.equal(result.renamedFiles.get('new/path.ts'), 'old/path.ts');
});

test('extractNewPathFromHeader: parses standard and tab-separated forms', () => {
  assert.equal(__test__.extractNewPathFromHeader('a/pkg/a.ts b/pkg/a.ts'), 'pkg/a.ts');
  assert.equal(__test__.extractNewPathFromHeader('a/pkg/a.ts\tb/pkg/a.ts'), 'pkg/a.ts');
  assert.equal(
    __test__.extractNewPathFromHeader('"a/file with space.ts" "b/file with space.ts"'),
    'file with space.ts',
  );
  assert.equal(__test__.extractNewPathFromHeader('malformed'), null);
});
