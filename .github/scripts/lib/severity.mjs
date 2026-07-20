// Severity rendering for inline review comments. Keeps the badge
// labels and emoji consistent across the poster, the dry-run summary,
// and any future surfaces (e.g. a CLI mode).

const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

const SEVERITY_BADGE = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

export function isSeverity(value) {
  return typeof value === 'string' && SEVERITIES.has(value);
}

export function severityBadge(severity) {
  return SEVERITY_BADGE[severity] ?? 'INFO';
}

/**
 * Render a finding as a single PR review comment body.
 * The GitHub review API expects each `comments[].body` to be
 * standalone markdown.
 */
export function renderFindingBody(finding) {
  const parts = [];
  parts.push(`**${severityBadge(finding.severity)}** — ${finding.title}`);
  parts.push('');
  parts.push(finding.body);
  if (finding.suggestion) {
    parts.push('');
    parts.push('**Suggested fix**');
    parts.push('');
    if (finding.suggestion.includes('\n')) {
      parts.push('```');
      parts.push(finding.suggestion);
      parts.push('```');
    } else {
      parts.push('`' + finding.suggestion + '`');
    }
  }
  parts.push('');
  parts.push('<sub>Posted by Letta Code inline review.</sub>');
  return parts.join('\n');
}

/**
 * Render the top-level review body that GitHub shows above the
 * inline comments.
 */
export function renderReviewSummary({ findings, dropped }) {
  const lines = [];
  if (findings.length === 0) {
    lines.push('**Letta Code** reviewed this pull request and found no material issues.');
  } else {
    lines.push(`**Letta Code** posted ${findings.length} inline comment${findings.length === 1 ? '' : 's'}.`);
    lines.push('');
    lines.push('| Severity | Title | File |');
    lines.push('| --- | --- | --- |');
    for (const f of findings) {
      lines.push(`| ${severityBadge(f.severity)} | ${escapeTable(f.title)} | \`${escapeTable(f.path)}\` |`);
    }
  }
  if (dropped.length > 0) {
    lines.push('');
    lines.push(`<sub>${dropped.length} finding${dropped.length === 1 ? '' : 's'} dropped because the model returned a path or line that did not match the PR diff.</sub>`);
  }
  return lines.join('\n');
}

function escapeTable(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
