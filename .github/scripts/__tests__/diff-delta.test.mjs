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
    ['pkg/a.ts', { added: new Set([2, 4]), deleted: new Set() }],
    ['pkg/b.ts', { added: new Set([2]), deleted: new Set() }],
  ]);

  const filtered = filterPatchToChangedLines(SAMPLE_PR_PATCH, changedLines);

  const anchors = parsePatchAnchors(filtered);
  // pkg/a.ts: first hunk touches right lines 1,2,3,4 — intersects {2,4} ✓
  //           second hunk touches 12,13,14 — none changed → drop
  // pkg/b.ts: hunk touches 1,2,3 — intersects {2} ✓
  assert.deepEqual([...anchors.right.get('pkg/a.ts')].sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.deepEqual([...anchors.right.get('pkg/b.ts')].sort((a, b) => a - b), [1, 2, 3]);
});

test('filterPatchToChangedLines drops files with no changed lines', () => {
  const changedLines = new Map([
    ['pkg/a.ts', { added: new Set([2]), deleted: new Set() }],
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
  assert.equal(
    filterPatchToChangedLines(
      '',
      new Map([['pkg/a.ts', { added: new Set([1]), deleted: new Set() }]]),
    ),
    '',
  );
  assert.equal(
    filterPatchToChangedLines(
      '   \n  ',
      new Map([['pkg/a.ts', { added: new Set([1]), deleted: new Set() }]]),
    ),
    '',
  );
});

test('filterPatchToChangedLines returns empty when no files changed', () => {
  const filtered = filterPatchToChangedLines(SAMPLE_PR_PATCH, new Map());
  assert.equal(filtered, '');
});

test('filterPatchToChangedLines passes deleted files through verbatim', () => {
  // pkg/a.ts is changed; pkg/b.ts is removed since the last review.
  // Both blocks should appear in the output: pkg/a.ts via the
  // changed-lines filter, pkg/b.ts via the deleted-files pass-through
  // (LEFT-side anchors are still valid for deleted-file hunks).
  const changedLines = new Map([
    ['pkg/a.ts', { added: new Set([2, 4]), deleted: new Set() }],
  ]);
  const removedFiles = new Set(['pkg/b.ts']);
  const filtered = filterPatchToChangedLines(SAMPLE_PR_PATCH, changedLines, { removedFiles });
  assert.ok(filtered.includes('pkg/a.ts'), 'changed file should appear');
  assert.ok(filtered.includes('pkg/b.ts'), 'deleted file should pass through');
});

test('filterPatchToChangedLines keeps hunks whose only changes are deletions', () => {
  // A deletion-only modification: lines 5-7 in old, no new lines
  // (just removals). The hunk has no `+` lines but `-` lines exist.
  // The delta map records deleted lines; the hunk filter must
  // keep the hunk so the model can fire LEFT-side findings.
  const deletionPatch = [
    'diff --git a/pkg/del.ts b/pkg/del.ts',
    'index 1111111..0000000 100644',
    '--- a/pkg/del.ts',
    '+++ b/pkg/del.ts',
    '@@ -5,3 +5,0 @@',
    ' line5',
    '-line6',
    '-line7',
  ].join('\n');
  const changedLines = new Map([
    ['pkg/del.ts', { added: new Set(), deleted: new Set([6, 7]) }],
  ]);
  const filtered = filterPatchToChangedLines(deletionPatch, changedLines);
  assert.ok(
    filtered.includes('-line6'),
    'pure-deletion hunk should be retained (LEFT-side anchors)',
  );
});

test('hunkIntersects: returns true when any right-side line is in added set', () => {
  const hunk = {
    header: '@@ -1,3 +1,4 @@',
    body: [
      ' line1',
      '+added2',
      ' line3',
      '+added4',
    ],
  };
  const changedSet = { added: new Set([4]), deleted: new Set() };
  assert.equal(__test__.hunkIntersects(hunk, changedSet), true);
  assert.equal(
    __test__.hunkIntersects(hunk, { added: new Set([100]), deleted: new Set() }),
    false,
  );
});

test('hunkIntersects: returns true when any left-side line is in deleted set', () => {
  // Pure-deletion hunk: old lines 5-7, no new lines.
  // deleted set {6} should make this hunk intersect.
  const hunk = {
    header: '@@ -5,3 +5,0 @@',
    body: [
      ' line5',
      '-line6',
      '-line7',
    ],
  };
  assert.equal(
    __test__.hunkIntersects(hunk, { added: new Set(), deleted: new Set([6]) }),
    true,
  );
  assert.equal(
    __test__.hunkIntersects(hunk, { added: new Set(), deleted: new Set([100]) }),
    false,
  );
});

test('hunkIntersects: ignores deletion-only lines for added-only set', () => {
  // Header says oldStart=1, oldCount=3 (3 lines in old), newStart=1,
  // newCount=2 (2 lines in new). Body:
  //   ' line1'   → context, right advances 1→2
  //   '-removed' → deletion, no right advance
  //   ' line2'   → context, right advances 2→3
  // Right lines: 1, 2. added={1} intersects.
  const hunk = {
    header: '@@ -1,3 +1,2 @@',
    body: [' line1', '-removed', ' line2'],
  };
  assert.equal(
    __test__.hunkIntersects(hunk, { added: new Set([1]), deleted: new Set() }),
    true,
  );
  assert.equal(
    __test__.hunkIntersects(hunk, { added: new Set([2]), deleted: new Set() }),
    true,
  );
  // Set {3} doesn't intersect; right line 3 doesn't exist in this hunk.
  assert.equal(
    __test__.hunkIntersects(hunk, { added: new Set([3]), deleted: new Set() }),
    false,
  );
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
  // Only the added line (2) should be in the changed set, not the
  // context lines (1, 3, 4).
  assert.deepEqual(
    [...result.changedLines.get('pkg/a.ts').added].sort((a, b) => a - b),
    [2],
  );
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
  // Only the added line (2) is "changed"; context lines (1, 3) are not.
  assert.deepEqual(
    [...result.changedLines.get('new/path.ts').added].sort((a, b) => a - b),
    [2],
  );
  assert.equal(result.renamedFiles.get('new/path.ts'), 'old/path.ts');
});

test('fetchChangedLinesSince: all-removal push keeps files in removedFiles only', async () => {
  const fakeGhApi = (endpoint) => {
    if (endpoint.includes('/compare/')) {
      return buildComparePayload({
        files: [
          { filename: 'pkg/gone.ts', status: 'removed', patch: '' },
          { filename: 'pkg/also-gone.ts', status: 'removed', patch: '' },
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
  assert.equal(result.changedLines.size, 0, 'no added lines');
  assert.equal(result.removedFiles.size, 2);
  assert.ok(result.removedFiles.has('pkg/gone.ts'));
  assert.ok(result.removedFiles.has('pkg/also-gone.ts'));
});

test('filterPatchToChangedLines: all-removal push passes deletions through', () => {
  // Simulates the PR-side patch for two removed files.
  const deletionPatch = [
    'diff --git a/pkg/gone.ts b/pkg/gone.ts',
    'deleted file mode 100644',
    'index 1111111..0000000',
    '--- a/pkg/gone.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-line1',
    '-line2',
    '-line3',
    'diff --git a/pkg/also-gone.ts b/pkg/also-gone.ts',
    'deleted file mode 100644',
    'index 2222222..0000000',
    '--- a/pkg/also-gone.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-a',
    '-b',
  ].join('\n');

  const result = filterPatchToChangedLines(deletionPatch, new Map(), {
    removedFiles: new Set(['pkg/gone.ts', 'pkg/also-gone.ts']),
  });
  assert.ok(result.includes('pkg/gone.ts'), 'gone file block should pass through');
  assert.ok(result.includes('pkg/also-gone.ts'), 'also-gone file block should pass through');
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

test('parseAddedAndDeletedLines: collects added and deleted lines, not context', () => {
  const patch = [
    '@@ -1,3 +1,4 @@',
    ' line1',
    '+added2',
    '-removed2',
    ' line3',
    '+added4',
  ].join('\n');
  const { added, deleted } = __test__.parseAddedAndDeletedLines(patch);
  assert.deepEqual(
    [...added].sort((a, b) => a - b),
    [2, 4],
    'context lines 1 and 3 should be excluded',
  );
  assert.deepEqual([...deleted].sort((a, b) => a - b), [2], 'one deletion on left line 2');
});

test('parseAddedAndDeletedLines: handles added files (all lines are added)', () => {
  const patch = [
    '@@ -0,0 +1,3 @@',
    '+line1',
    '+line2',
    '+line3',
  ].join('\n');
  const { added, deleted } = __test__.parseAddedAndDeletedLines(patch);
  assert.deepEqual([...added].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(deleted.size, 0);
});

test('parseAddedAndDeletedLines: returns added empty, deleted full for pure-deletion hunk', () => {
  const patch = [
    '@@ -1,3 +1,1 @@',
    '-line1',
    '-line2',
    '-line3',
  ].join('\n');
  const { added, deleted } = __test__.parseAddedAndDeletedLines(patch);
  assert.equal(added.size, 0);
  assert.deepEqual([...deleted].sort((a, b) => a - b), [1, 2, 3]);
});

test('parseAddedAndDeletedLines: stops at hunk boundary', () => {
  const patch = [
    '@@ -1,2 +1,3 @@',
    ' a',
    '+b',
    ' c',
    '@@ -10,1 +11,2 @@',
    '+d',
    ' e',
  ].join('\n');
  const { added } = __test__.parseAddedAndDeletedLines(patch);
  assert.deepEqual([...added].sort((a, b) => a - b), [2, 11]);
});
