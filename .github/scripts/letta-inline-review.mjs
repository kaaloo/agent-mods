#!/usr/bin/env node
// letta-inline-review.mjs
//
// Fetches a pull request diff, calls the configured Letta agent with a
// strict-JSON-schema system prompt, validates every returned finding's
// path/line anchor against the diff, and posts a single PR review with
// inline comments. Designed to run as a single step in the
// letta-code.yml inline-review job.
//
// Inputs come from process.env (set by the workflow). The script
// never reads .env files; testing is done by setting the same env
// vars locally.
//
// Required env:
//   LETTA_API_KEY
//   LETTA_REVIEW_AGENT
//   LETTA_REVIEW_MODEL          ("auto" or a full Letta model handle)
//   GITHUB_TOKEN
//   GITHUB_REPOSITORY           ("owner/repo")
//   PR_NUMBER
//   PR_HEAD_SHA
//
// Optional env:
//   DRY_RUN                     ("true" disables posting; prints summary only)
//   LETTA_BASE_URL              (override the Letta API base URL)
//   MAX_FINDINGS                (default 20)

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import Letta from '@letta-ai/letta-client';
import { parsePatchAnchors } from './lib/github-anchors.mjs';
import { isSeverity, renderFindingBody, renderReviewSummary } from './lib/severity.mjs';
import {
  loadLastReviewedSha,
  recordLastReviewedSha,
} from './lib/inline-review-state.mjs';
import {
  fetchChangedLinesSince,
  filterPatchToChangedLines,
} from './lib/diff-delta.mjs';
import {
  loadAckedAnchors,
  dropAckedFindings,
} from './lib/acked-comments.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(__dirname, '..', 'prompts', 'letta-inline-review.system.md');

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
const MAX_DIFF_CHARS = 100_000;
const MAX_GH_OUTPUT_BYTES = 20 * 1024 * 1024;

// Lockfile basenames. Lockfiles are generated and rarely reviewable
// signal: the reviewable intent lives in package.json / pyproject.toml /
// Cargo.toml etc., and the resolved dependency graph is rebuilt by the
// package manager. Lockfiles can easily push a PR's diff past
// MAX_DIFF_CHARS, so we strip them from the reviewer's input. Add new
// basenames here rather than threading a config flag.
const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
]);

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function ghApi(endpoint, { method = 'GET', headers = [], body } = {}) {
  const args = ['api', endpoint, '--method', method];
  for (const header of headers) args.push('--header', header);
  if (body !== undefined) args.push('--input', '-');

  return execFileSync('gh', args, {
    encoding: 'utf8',
    input: body === undefined ? undefined : JSON.stringify(body),
    maxBuffer: MAX_GH_OUTPUT_BYTES,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

function appendStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, markdown + '\n', 'utf8');
}

function asBool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function asInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function buildUserMessage({ repository, pullNumber, title, author, baseRef, headRef, diff, prUrl }) {
  return [
    `Review pull request #${pullNumber} on ${repository}.`,
    `Title: ${title}`,
    `Author: ${author}`,
    `Base: ${baseRef}  Head: ${headRef}`,
    `URL: ${prUrl}`,
    '',
    'Return a JSON array of inline findings, or an empty array if there are no material issues. See the system prompt for the schema and the hard limits.',
    '',
    '```diff',
    diff,
    '```',
  ].join('\n');
}

function extractAssistantText(messages) {
  const content = messages.at(-1)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

function extractJsonBlock(text) {
  if (!text) return null;
  // Find the LAST fenced ```json ... ``` block. If the model emitted
  // an explanation before the block, we ignore it. If it emitted
  // multiple blocks, the last one wins (matches the "single fenced
  // json code block" contract).
  const matches = [...text.matchAll(/```json\s*\n([\s\S]*?)```/gi)];
  if (matches.length > 0) return matches.at(-1)[1].trim();
  // Fallback: try to parse the entire response as JSON. Some models
  // skip the fence when returning the empty array `[]`.
  const trimmed = text.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed;
  return null;
}

function parseFindings(jsonText) {
  if (!jsonText) return { findings: [], parseError: 'No JSON code block in model output.' };
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { findings: [], parseError: `JSON parse error: ${err.message}` };
  }
  if (!Array.isArray(parsed)) {
    return { findings: [], parseError: 'Top-level JSON value is not an array.' };
  }
  const findings = [];
  for (const [index, item] of parsed.entries()) {
    if (!item || typeof item !== 'object') {
      return { findings: [], parseError: `Finding ${index + 1} is not an object.` };
    }
    const path = typeof item.path === 'string' ? item.path : null;
    const line = parseLineNumber(item.line);
    const side = normalizeSide(item.side);
    const severity = normalizeSeverity(item.severity);
    const title = typeof item.title === 'string' ? item.title : null;
    const body = typeof item.body === 'string' ? item.body : null;
    const suggestion = typeof item.suggestion === 'string' ? item.suggestion : null;
    const suggestionIsValid = item.suggestion === undefined || typeof item.suggestion === 'string';
    if (!path || !line || !side || !severity || !title || !body || !suggestionIsValid) {
      return { findings: [], parseError: `Finding ${index + 1} is missing a required field.` };
    }
    findings.push({ path, line, side, severity, title, body, suggestion });
  }
  return { findings, parseError: null };
}

function parseLineNumber(value) {
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

function normalizeSide(value) {
  if (value === undefined) return 'RIGHT';
  if (typeof value !== 'string') return null;
  const normalized = value.toUpperCase();
  return normalized === 'LEFT' || normalized === 'RIGHT' ? normalized : null;
}

function normalizeSeverity(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  return isSeverity(normalized) ? normalized : null;
}

function validateAnchors(findings, anchors) {
  const valid = [];
  const dropped = [];
  for (const f of findings) {
    const allowed = f.side === 'LEFT' ? anchors.left : anchors.right;
    const set = allowed.get(f.path);
    if (set && set.has(f.line)) {
      valid.push(f);
    } else {
      dropped.push({ ...f, reason: `${f.side} line ${f.line} not in diff for ${f.path}` });
    }
  }
  return { valid, dropped };
}

function capFindings(findings, max) {
  if (findings.length <= max) return findings;
  return [...findings]
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9))
    .slice(0, max);
}

function fetchPullRequest(repository, pullNumber) {
  return JSON.parse(ghApi(`repos/${repository}/pulls/${pullNumber}`));
}

function fetchPullRequestDiff(repository, pullNumber) {
  return ghApi(`repos/${repository}/pulls/${pullNumber}`, {
    headers: ['Accept: application/vnd.github.diff'],
  });
}

function assertPullRequestHead(pr, expectedHeadSha) {
  const actualHeadSha = pr.head?.sha;
  if (actualHeadSha !== expectedHeadSha) {
    throw new Error(`PR head changed from ${expectedHeadSha} to ${actualHeadSha ?? 'unknown'} during review.`);
  }
}

async function postNoDeltaComment({ repository, pullNumber, headSha, priorSha }) {
  const sinceLabel = priorSha ? ` since \`${priorSha.slice(0, 7)}\`` : '';
  const body =
    '**Letta Code** found no new inline findings.\n\n' +
    'No source lines changed' + sinceLabel + ' on this push. ' +
    'Skipped re-running the reviewer to avoid re-flagging previously acknowledged lines.\n\n' +
    `<sub>Commit: \`${headSha.slice(0, 7)}\`</sub>`;
  ghApi(`repos/${repository}/issues/${pullNumber}/comments`, {
    method: 'POST',
    body: { body },
  });
}

async function recordMarker({ repository, pullNumber, headSha }) {
  try {
    await recordLastReviewedSha({
      repository,
      pullNumber,
      headSha,
      reviewedSha: headSha,
      ghApi,
    });
  } catch (err) {
    // Marker persistence is best-effort: a failure here would
    // otherwise block the reviewer run. Log to the step summary
    // and continue.
    appendStepSummary(
      `\n_Warning: could not record the inline-review state marker: ${err?.message ?? String(err)}._\n`,
    );
  }
}

// Strip diff blocks for paths whose basename matches LOCKFILE_BASENAMES.
// Returns the trimmed patch and a list of dropped paths so callers can
// log them. Uses the same `diff --git ` boundary split as
// lib/github-anchors.mjs so behavior stays consistent.
function stripExcludedFiles(patch) {
  if (!patch) return { patch: '', excluded: [] };
  const excluded = [];
  const blocks = patch.split(/^diff --git /m);
  // blocks[0] is the preamble (usually empty for `gh api .../pulls/N`
  // with the diff accept header). Always keep it.
  const preamble = blocks[0] ?? '';
  const kept = [preamble];
  for (const block of blocks.slice(1)) {
    const firstLine = block.split('\n', 1)[0] ?? '';
    const newPath = extractNewPathFromDiffHeader(firstLine);
    if (newPath && LOCKFILE_BASENAMES.has(basename(newPath))) {
      excluded.push(newPath);
      continue;
    }
    kept.push(`diff --git ${block}`);
  }
  return { patch: kept.join(''), excluded };
}

function extractNewPathFromDiffHeader(headerLine) {
  // headerLine is "a/<path> b/<path>" possibly with quoted paths or
  // tabs. Mirror the relevant subset of lib/github-anchors.mjs logic
  // so we identify the same file the anchor parser would.
  const quoted = headerLine.match(/^"((?:\\.|[^"])*)"\s+"((?:\\.|[^"])*)"$/);
  if (quoted) {
    return decodeGitQuotedPath(quoted[2]).replace(/^b\//, '');
  }
  if (headerLine.includes('\t')) {
    const parts = headerLine.split('\t');
    if (parts.length >= 2) {
      return stripABPrefix(parts[1].trim());
    }
  }
  const match = headerLine.match(/^a\/(.+?) b\/(.+)$/);
  if (match) return match[2];
  return null;
}

function stripABPrefix(p) {
  return p.startsWith('b/') ? p.slice(2) : p;
}

function basename(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function decodeGitQuotedPath(path) {
  // Minimal decoder for the common escapes Git uses in quoted diff
  // paths. Mirrors lib/github-anchors.mjs so behavior matches.
  return path.replace(/\\(.)/g, (_, c) => {
    const escapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\x0b' };
    return escapes[c] ?? c;
  });
}

async function main() {
  required('GITHUB_TOKEN');
  const apiKey = required('LETTA_API_KEY');
  const agentId = required('LETTA_REVIEW_AGENT');
  const model = required('LETTA_REVIEW_MODEL');
  const repository = required('GITHUB_REPOSITORY');
  const pullNumber = asInt(process.env.PR_NUMBER, null);
  if (!pullNumber) throw new Error('PR_NUMBER must be an integer.');
  const headSha = required('PR_HEAD_SHA');
  const baseRef = process.env.PR_BASE_REF ?? 'main';
  const headRef = process.env.PR_HEAD_REF ?? 'HEAD';
  const prUrl = process.env.PR_URL ?? `https://github.com/${repository}/pull/${pullNumber}`;
  const dryRun = asBool(process.env.DRY_RUN, false);
  const maxFindings = asInt(process.env.MAX_FINDINGS, 20);

  const systemPrompt = await readFile(PROMPT_PATH, 'utf8');

  appendStepSummary(`### Letta Code inline review\n\nFetching PR #${pullNumber} from ${repository} @ ${headSha.slice(0, 7)}...\n`);

  const pr = fetchPullRequest(repository, pullNumber);
  assertPullRequestHead(pr, headSha);
  const rawPatch = fetchPullRequestDiff(repository, pullNumber);
  const { patch, excluded } = stripExcludedFiles(rawPatch);
  if (excluded.length > 0) {
    const savedBytes = rawPatch.length - patch.length;
    appendStepSummary(
      `Excluded ${excluded.length} lockfile(s) from the review diff (${savedBytes.toLocaleString()} bytes skipped):\n` +
      excluded.map((p) => `- \`${p}\``).join('\n') + '\n\n',
    );
  }
  if (!patch.trim()) {
    appendStepSummary('_No reviewable patch content after excluding lockfiles. The PR may consist entirely of generated changes. Skipping inline review._\n');
    return;
  }

  // Apply the delta filter: if a prior reviewed SHA is recorded on
  // the PR and reachable from the current head, restrict the
  // reviewer's input to hunks whose lines changed since then.
  // This prevents re-firing findings on lines the author already
  // acknowledged on a previous push. See issue #14.
  const prior = await loadLastReviewedSha({ repository, pullNumber, ghApi });
  let reviewablePatch = patch;
  let deltaMode = 'full';
  let changedLines = null;
  let removedFiles = new Set();
  if (prior) {
    const delta = await fetchChangedLinesSince({
      repository,
      baseSha: prior.sha,
      headSha,
      ghApi,
    });
    if (delta.ok) {
      changedLines = delta.changedLines;
      removedFiles = delta.removedFiles;
      if (changedLines.size === 0 && delta.removedFiles.size === 0) {
        appendStepSummary(
          `_No lines changed since last reviewed commit \`${prior.sha.slice(0, 7)}\`. ` +
          `Posting a 'no new findings' note instead of re-running the reviewer._\n`,
        );
        await postNoDeltaComment({ repository, pullNumber, headSha, priorSha: prior.sha });
        await recordMarker({ repository, pullNumber, headSha });
        return;
      }
      reviewablePatch = filterPatchToChangedLines(patch, changedLines, { removedFiles });
      deltaMode = 'delta';
      appendStepSummary(
        `Filtered diff to lines changed since last reviewed commit \`${prior.sha.slice(0, 7)}\` ` +
        `(${changedLines.size} file${changedLines.size === 1 ? '' : 's'} with changes, ` +
        `${removedFiles.size} deletion${removedFiles.size === 1 ? '' : 's'}).\n`,
      );
    } else if (delta.reason === 'sha-not-reachable') {
      // Force-push orphaned the marker. Fall back to a full review,
      // but apply the secondary line-aware filter so already-acked
      // line anchors do not re-fire.
      appendStepSummary(
        `_Last reviewed commit \`${prior.sha.slice(0, 7)}\` is not reachable from the current head ` +
        `(likely a force-push). Falling back to a full review and applying the line-aware prior-reply filter._\n`,
      );
      deltaMode = 'full-after-force-push';
    } else {
      appendStepSummary(
        `_Could not compute delta against last reviewed commit \`${prior.sha.slice(0, 7)}\` ` +
        `(reason: ${delta.reason}). Falling back to a full review._\n`,
      );
      deltaMode = 'full-fallback';
    }
  } else {
    appendStepSummary('_No prior reviewed commit recorded; running a full review._\n');
    deltaMode = 'first-push';
  }

  if (!reviewablePatch.trim()) {
    // Delta filtered everything out (e.g. only deletions, which we
    // suppress). Post a short note and update the marker so the
    // next push can compute a fresh delta from this head.
    appendStepSummary('_No reviewable hunks remain after the delta filter. Posting a no-op note._\n');
    await postNoDeltaComment({ repository, pullNumber, headSha, priorSha: prior?.sha ?? headSha });
    await recordMarker({ repository, pullNumber, headSha });
    return;
  }
  if (reviewablePatch.length > MAX_DIFF_CHARS) {
    throw new Error(`Filtered reviewable patch is ${reviewablePatch.length} characters; maximum reviewable size is ${MAX_DIFF_CHARS}.`);
  }

  const anchors = parsePatchAnchors(reviewablePatch);
  const userMessage = buildUserMessage({
    repository,
    pullNumber,
    title: pr.title ?? '',
    author: pr.user?.login ?? 'unknown',
    baseRef,
    headRef,
    diff: reviewablePatch,
    prUrl: pr.html_url ?? prUrl,
  });

  appendStepSummary(`Calling Letta agent \`${agentId}\` with model \`${model}\`...\n`);

  const client = new Letta({
    apiKey,
    timeout: 120_000,
    ...(process.env.LETTA_BASE_URL ? { baseURL: process.env.LETTA_BASE_URL } : {}),
  });
  const response = await client.agents.messages.create(agentId, {
    input: userMessage,
    override_system: systemPrompt,
    streaming: false,
    include_return_message_types: ['assistant_message'],
    ...(model !== 'auto' ? { override_model: model } : {}),
  });
  const text = extractAssistantText(response.messages);
  assertPullRequestHead(fetchPullRequest(repository, pullNumber), headSha);

  const jsonText = extractJsonBlock(text);
  const { findings: rawFindings, parseError } = parseFindings(jsonText);

  if (parseError) {
    throw new Error(`${parseError}\n\nRaw model output (first 500 chars):\n${(text ?? '').slice(0, 500)}`);
  }

  const anchorValidation = validateAnchors(rawFindings, anchors);
  let { valid } = anchorValidation;
  const { dropped: anchorDropped } = anchorValidation;

  // Secondary safety net: drop findings anchored to lines the PR
  // author (or repo owner) has already replied to. This catches
  // already-acked line noise in the full-review paths (first push,
  // force-push orphan). The delta filter already handles the
  // common case; this layer is belt-and-suspenders.
  const ackedDropped = [];
  if (deltaMode !== 'delta') {
    const { acked } = await loadAckedAnchors({ repository, pullNumber, ghApi });
    if (acked.size > 0) {
      const result = dropAckedFindings(valid, acked);
      valid = result.kept;
      ackedDropped.push(...result.dropped);
    }
  }

  const capped = capFindings(valid, maxFindings);
  const dropped = [...anchorDropped, ...ackedDropped];

  appendStepSummary([
    `### Findings`,
    '',
    `- Raw findings from model: ${rawFindings.length}`,
    `- Dropped (bad anchor): ${dropped.length}`,
    `- Dropped (over cap): ${Math.max(0, valid.length - capped.length)}`,
    `- Posting: ${capped.length}`,
    '',
  ].join('\n'));

  if (dropped.length > 0) {
    appendStepSummary(
      '<details><summary>Dropped findings</summary>\n\n' +
      dropped.map((d) => `- \`${d.path}:${d.line}\` (${d.side}) — ${d.title} — ${d.reason}`).join('\n') +
      '\n\n</details>\n',
    );
  }

  if (dryRun) {
    appendStepSummary('\n**Dry run enabled.** No comments posted to the PR.\n');
    if (capped.length > 0) {
      appendStepSummary(
        '<details><summary>Would-post comments (dry run)</summary>\n\n' +
        capped.map((f) => `#### \`${f.path}:${f.line}\` (${f.side}) — ${f.severity}\n\n${renderFindingBody(f)}`).join('\n\n') +
        '\n\n</details>\n',
      );
    }
    return;
  }

  const reviewBody = renderReviewSummary({ findings: capped, dropped });
  const comments = capped.map((f) => ({ path: f.path, line: f.line, side: f.side, body: renderFindingBody(f) }));

  if (comments.length === 0) {
    // No findings: post a single top-level comment so the author
    // sees that the review ran.
    ghApi(`repos/${repository}/issues/${pullNumber}/comments`, {
      method: 'POST',
      body: { body: `${reviewBody}\n\n<sub>Commit: \`${headSha.slice(0, 7)}\`</sub>` },
    });
    appendStepSummary('Posted no-issues comment.\n');
    await recordMarker({ repository, pullNumber, headSha });
    return;
  }

  ghApi(`repos/${repository}/pulls/${pullNumber}/reviews`, {
    method: 'POST',
    body: {
      commit_id: headSha,
      body: reviewBody,
      event: 'COMMENT',
      comments,
    },
  });
  appendStepSummary(`Posted PR review with ${comments.length} inline comment${comments.length === 1 ? '' : 's'}.\n`);
  await recordMarker({ repository, pullNumber, headSha });
}

main().catch((err) => {
  // Surface the error in the step summary AND throw so the workflow
  // step fails. Throwing is important: a silent failure here means
  // the PR gets no review at all and nobody notices.
  const message = err && err.stack ? err.stack : String(err);
  appendStepSummary(`\n**Fatal error:**\n\n\`\`\`\n${message}\n\`\`\`\n`);
  console.error(message);
  process.exit(1);
});
