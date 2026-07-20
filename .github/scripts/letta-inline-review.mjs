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
//   LETTA_AGENT_ID
//   LETTA_MODEL                 ("auto" or a full Letta model handle)
//   GITHUB_TOKEN
//   GITHUB_REPOSITORY           ("owner/repo")
//   PR_NUMBER
//   PR_HEAD_SHA
//
// Optional env:
//   DRY_RUN                     ("true" disables posting; prints summary only)
//   LETTA_BASE_URL              (override the Letta API base URL)
//   MAX_FINDINGS                (default 20)

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { sendAgentMessage } from './lib/letta-client.mjs';
import { parsePatchAnchors } from './lib/github-anchors.mjs';
import { postPullRequestReview, postIssueComment, appendStepSummary } from './lib/review-posting.mjs';
import { isSeverity, renderFindingBody, renderReviewSummary } from './lib/severity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = resolve(__dirname, '..', 'prompts', 'letta-inline-review.system.md');

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function asBool(v, fallback = false) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function asInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function diffForPrompt(patch, maxChars = 100_000) {
  if (patch.length <= maxChars) return patch;
  return patch.slice(0, maxChars) + '\n... (diff truncated to fit prompt budget)';
}

function buildUserMessage({ title, author, baseRef, headRef, diff, prUrl }) {
  return [
    `Review pull request #${required('PR_NUMBER')} on ${required('GITHUB_REPOSITORY')}.`,
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
  for (const [i, item] of parsed.entries()) {
    if (!item || typeof item !== 'object') continue;
    const path = typeof item.path === 'string' ? item.path : null;
    const line = parseLineNumber(item.line);
    const side = normalizeSide(item.side);
    const severity = normalizeSeverity(item.severity);
    const title = typeof item.title === 'string' ? item.title : null;
    const body = typeof item.body === 'string' ? item.body : null;
    const suggestion = typeof item.suggestion === 'string' ? item.suggestion : null;
    if (!path || !line || !severity || !title || !body) {
      continue; // Drop malformed entries silently.
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
  return typeof value === 'string' && value.toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT';
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

async function fetchPullRequest({ token, owner, repo, pullNumber }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'letta-inline-review',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub PR GET ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

async function fetchPullRequestDiff({ token, owner, repo, pullNumber }) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.diff',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'letta-inline-review',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub PR diff GET ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  }
  return text;
}

async function main() {
  const token = required('GITHUB_TOKEN');
  const apiKey = required('LETTA_API_KEY');
  const agentId = required('LETTA_AGENT_ID');
  const model = required('LETTA_MODEL');
  const [owner, repo] = required('GITHUB_REPOSITORY').split('/');
  const pullNumber = asInt(process.env.PR_NUMBER, null);
  if (!pullNumber) throw new Error('PR_NUMBER must be an integer.');
  const headSha = required('PR_HEAD_SHA');
  const baseRef = process.env.PR_BASE_REF ?? 'main';
  const headRef = process.env.PR_HEAD_REF ?? 'HEAD';
  const prUrl = process.env.PR_URL ?? `https://github.com/${owner}/repo/pull/${pullNumber}`;
  const dryRun = asBool(process.env.DRY_RUN, false);
  const maxFindings = asInt(process.env.MAX_FINDINGS, 20);

  const systemPrompt = await readFile(PROMPT_PATH, 'utf8');

  appendStepSummary(`### Letta Code inline review\n\nFetching PR #${pullNumber} from ${owner}/${repo} @ ${headSha.slice(0, 7)}...\n`);

  const [pr, patch] = await Promise.all([
    fetchPullRequest({ token, owner, repo, pullNumber }),
    fetchPullRequestDiff({ token, owner, repo, pullNumber }),
  ]);
  if (!patch.trim()) {
    appendStepSummary('_No patch content in PR response. The PR may be too large to diff, or consist entirely of binary changes. Skipping inline review._\n');
    return;
  }

  const anchors = parsePatchAnchors(patch);
  const userMessage = buildUserMessage({
    title: pr.title ?? '',
    author: pr.user?.login ?? 'unknown',
    baseRef,
    headRef,
    diff: diffForPrompt(patch),
    prUrl: pr.html_url ?? prUrl,
  });

  appendStepSummary(`Calling Letta agent \`${agentId}\` with model \`${model}\`...\n`);

  const { text } = await sendAgentMessage({
    agentId,
    userMessage,
    systemPrompt,
    apiKey,
    model,
    baseUrl: process.env.LETTA_BASE_URL,
  });

  const jsonText = extractJsonBlock(text);
  const { findings: rawFindings, parseError } = parseFindings(jsonText);

  if (parseError) {
    appendStepSummary(`**Parse error:** ${parseError}\n\nRaw model output (first 500 chars):\n\n\`\`\`\n${(text ?? '').slice(0, 500)}\n\`\`\`\n`);
  }

  const { valid, dropped } = validateAnchors(rawFindings, anchors);
  const capped = capFindings(valid, maxFindings);

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
    await postIssueComment({
      token,
      owner,
      repo,
      issueNumber: pullNumber,
      body: `${reviewBody}\n\n<sub>Commit: \`${headSha.slice(0, 7)}\`</sub>`,
    });
    appendStepSummary('Posted no-issues comment.\n');
    return;
  }

  await postPullRequestReview({
    token,
    owner,
    repo,
    pullNumber,
    body: reviewBody,
    commitId: headSha,
    comments,
    event: 'COMMENT',
  });
  appendStepSummary(`Posted PR review with ${comments.length} inline comment${comments.length === 1 ? '' : 's'}.\n`);
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
