// Wraps the GitHub REST API calls needed to post an inline-anchored
// PR review, post a top-level PR comment, and write a job summary.
// Uses fetch directly (no octokit dep) and authenticates with the
// workflow's GITHUB_TOKEN.

import { appendFileSync } from 'node:fs';

const API = 'https://api.github.com';

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'letta-inline-review',
  };
}

/**
 * Post a PR review with inline comments.
 *
 * @param {object} args
 * @param {string} args.token
 * @param {string} args.owner
 * @param {string} args.repo
 * @param {number} args.pullNumber
 * @param {string} args.body - Review body shown above inline comments.
 * @param {string} args.commitId - HEAD SHA of the PR.
 * @param {Array<{path: string, line: number, side?: 'LEFT'|'RIGHT', body: string}>} args.comments
 * @param {'COMMENT'|'APPROVE'|'REQUEST_CHANGES'} [args.event='COMMENT']
 */
export async function postPullRequestReview({
  token,
  owner,
  repo,
  pullNumber,
  body,
  commitId,
  comments,
  event = 'COMMENT',
}) {
  const url = `${API}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;
  const payload = {
    commit_id: commitId,
    body,
    event,
    comments: comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? 'RIGHT',
      body: c.body,
    })),
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub PR review POST ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
    );
  }
  return JSON.parse(text);
}

/**
 * Post a top-level issue/PR comment.
 */
export async function postIssueComment({ token, owner, repo, issueNumber, body }) {
  const url = `${API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GitHub issue comment POST ${response.status} ${response.statusText}: ${text.slice(0, 500)}`,
    );
  }
  return JSON.parse(text);
}

/**
 * Write content to $GITHUB_STEP_SUMMARY. No-op if the env var is
 * not set (i.e. local execution).
 */
export function appendStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  appendFileSync(summaryPath, markdown + '\n', 'utf8');
}
