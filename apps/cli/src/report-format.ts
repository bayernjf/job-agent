/**
 * CLI 报告格式化：把 AbilityProfile 渲染为 Markdown / HTML（#7）。
 *
 * - JSON 仍由 CLI 主流程直接序列化（完整结构化数据）。
 * - Markdown / HTML 面向人工阅读：概览、技能、活跃度、协作、真实性、面试题、盲区。
 * - 纯函数、无 I/O，便于单测。
 */
import type { AbilityProfile, AuthenticitySignal } from '@jobagent/shared';

// ─── 公共小工具 ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function statusLabel(status: AbilityProfile['authenticity']['status']): string {
  switch (status) {
    case 'likely_authentic':
      return 'Likely Authentic';
    case 'mixed_signals':
      return 'Mixed Signals';
    case 'suspicious':
      return 'Suspicious';
    case 'insufficient_data':
      return 'Insufficient Data';
    default:
      return status;
  }
}

function signalRow(sig: AuthenticitySignal): string {
  return `- **${sig.label}** (${sig.severity}): ${sig.detail}`;
}

// ─── Markdown ────────────────────────────────────────────────────────────

export function toMarkdown(p: AbilityProfile): string {
  const lines: string[] = [];
  const s = p.subject;
  const a = p.authenticity;

  lines.push(`# Ability Profile — ${s.login}`);
  lines.push('');
  lines.push(`- **Profile URL**: ${s.profileUrl}`);
  lines.push(`- **Generated**: ${formatDate(p.generatedAt)}`);
  lines.push(`- **Data window**: ${formatDate(p.dataWindow.since)} → ${formatDate(p.dataWindow.until)}`);
  lines.push(`- **Analysis layers**: ${p.analysisLayers.join(', ')}`);
  lines.push(`- **Analyzer version**: ${p.analyzerVersion}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push(p.summary.headline);
  if (p.summary.seniorityHint) {
    lines.push('');
    lines.push(`Seniority hint: **${p.summary.seniorityHint.band}** (confidence ${(p.summary.seniorityHint.confidence * 100).toFixed(0)}%)`);
  }
  lines.push('');

  // Skill tags
  lines.push('## Skill Tags');
  if (p.skillTags.length === 0) {
    lines.push('_No skill tags detected._');
  } else {
    for (const tag of p.skillTags) {
      lines.push(`- \`${tag.name}\` — ${tag.kind} / ${tag.depth}`);
    }
  }
  lines.push('');

  // Activity
  lines.push('## Activity');
  if (p.activity.longevityMonths !== undefined) {
    lines.push(`- Longevity: **${p.activity.longevityMonths} months**`);
  }
  if (p.activity.cadenceSummary) lines.push(`- Cadence: ${p.activity.cadenceSummary}`);
  if (p.activity.metrics) {
    for (const [k, v] of Object.entries(p.activity.metrics)) {
      lines.push(`- ${k}: ${v}`);
    }
  }
  lines.push('');

  // Collaboration
  lines.push('## Collaboration');
  if (p.collaboration.prSummary) lines.push(p.collaboration.prSummary);
  if (p.collaboration.externalMergedContributions?.length) {
    lines.push('');
    lines.push('External merged contributions:');
    for (const ref of p.collaboration.externalMergedContributions) lines.push(`- ${ref}`);
  }
  lines.push('');

  // Authenticity
  lines.push('## Authenticity');
  lines.push(`- **Status**: ${statusLabel(a.status)}`);
  lines.push(`- **Confidence**: ${(a.confidence * 100).toFixed(0)}%`);
  if (a.signals.length > 0) {
    lines.push('');
    lines.push('Signals:');
    for (const sig of a.signals) lines.push(signalRow(sig));
  }
  lines.push('');

  // Interview questions
  lines.push('## Suggested Interview Questions');
  if (p.interviewQuestions.length === 0) {
    lines.push('_None._');
  } else {
    for (const q of p.interviewQuestions) {
      lines.push(`- **Q**: ${q.question}`);
      lines.push(`  - Intent: ${q.intent}`);
    }
  }
  lines.push('');

  // Caveats
  lines.push('## Caveats');
  if (p.caveats.length === 0) {
    lines.push('_None._');
  } else {
    for (const c of p.caveats) lines.push(`- ${c}`);
  }
  lines.push('');

  return lines.join('\n');
}

// ─── HTML ────────────────────────────────────────────────────────────────

export function toHtml(p: AbilityProfile): string {
  const s = p.subject;
  const a = p.authenticity;
  const skills = p.skillTags.length
    ? `<ul>${p.skillTags.map((t) => `<li><code>${escapeHtml(t.name)}</code> — ${escapeHtml(t.kind)} / ${escapeHtml(t.depth)}</li>`).join('')}</ul>`
    : '<p><em>No skill tags detected.</em></p>';

  const activityMetrics = p.activity.metrics
    ? `<ul>${Object.entries(p.activity.metrics).map(([k, v]) => `<li>${escapeHtml(k)}: ${v}</li>`).join('')}</ul>`
    : '';
  const external = p.collaboration.externalMergedContributions?.length
    ? `<p>External merged contributions:</p><ul>${p.collaboration.externalMergedContributions.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
    : '';
  const signals = a.signals.length
    ? `<ul>${a.signals.map((sig) => `<li><strong>${escapeHtml(sig.label)}</strong> (${escapeHtml(sig.severity)}): ${escapeHtml(sig.detail)}</li>`).join('')}</ul>`
    : '';
  const questions = p.interviewQuestions.length
    ? `<ol>${p.interviewQuestions.map((q) => `<li><strong>Q:</strong> ${escapeHtml(q.question)}<br><span class="muted">Intent: ${escapeHtml(q.intent)}</span></li>`).join('')}</ol>`
    : '<p><em>None.</em></p>';
  const caveats = p.caveats.length
    ? `<ul>${p.caveats.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>`
    : '<p><em>None.</em></p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ability Profile — ${escapeHtml(s.login)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; line-height: 1.6; }
  h1 { border-bottom: 2px solid #eee; padding-bottom: .4rem; }
  h2 { margin-top: 2rem; color: #2c3e50; }
  code { background: #f4f4f4; padding: .1em .35em; border-radius: 3px; font-size: .9em; }
  .meta { color: #555; font-size: .92rem; }
  .badge { display: inline-block; padding: .15em .6em; border-radius: 12px; background: #e8f0fe; color: #174ea6; font-weight: 600; }
  .muted { color: #777; font-size: .9em; }
  ul, ol { padding-left: 1.4rem; }
</style>
</head>
<body>
<h1>Ability Profile — ${escapeHtml(s.login)}</h1>
<p class="meta">
  <a href="${escapeHtml(s.profileUrl)}">${escapeHtml(s.profileUrl)}</a><br>
  Generated ${formatDate(p.generatedAt)} ·
  Window ${formatDate(p.dataWindow.since)} → ${formatDate(p.dataWindow.until)} ·
  Layers ${p.analysisLayers.join(', ')} ·
  ${escapeHtml(p.analyzerVersion)}
</p>

<h2>Summary</h2>
<p>${escapeHtml(p.summary.headline)}</p>
${p.summary.seniorityHint ? `<p>Seniority hint: <strong>${escapeHtml(p.summary.seniorityHint.band)}</strong> (${(p.summary.seniorityHint.confidence * 100).toFixed(0)}%)</p>` : ''}

<h2>Skill Tags</h2>
${skills}

<h2>Activity</h2>
${p.activity.longevityMonths !== undefined ? `<p>Longevity: <strong>${p.activity.longevityMonths} months</strong></p>` : ''}
${p.activity.cadenceSummary ? `<p>Cadence: ${escapeHtml(p.activity.cadenceSummary)}</p>` : ''}
${activityMetrics}

<h2>Collaboration</h2>
${p.collaboration.prSummary ? `<p>${escapeHtml(p.collaboration.prSummary)}</p>` : ''}
${external}

<h2>Authenticity</h2>
<p>Status: <span class="badge">${statusLabel(a.status)}</span> · Confidence: ${(a.confidence * 100).toFixed(0)}%</p>
${signals}

<h2>Suggested Interview Questions</h2>
${questions}

<h2>Caveats</h2>
${caveats}
</body>
</html>
`;
}
