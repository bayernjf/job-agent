/**
 * 简历 Markdown 渲染（纯函数、ATS 友好：单栏、标准标题、无表格布局）。
 * 所有外部文本做最小转义，防止 claim/补填文本破坏 Markdown 结构。
 */
import type { ResumeDraft, ResumeEntry } from '@jobagent/shared';
import { resumeCopy } from '../i18n.js';

function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}\[\]<>])/g, '\\$1');
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function entryLine(e: ResumeEntry, supportsLabel: string): string {
  const date = formatDate(e.occurredAt);
  const supports = e.supportsSkills.length > 0 ? ` _(${supportsLabel}: ${e.supportsSkills.map(escapeMd).join(', ')})_` : '';
  const link = e.url ? `[${escapeMd(e.text)}](${e.url})` : escapeMd(e.text);
  const meta = [e.source === 'local' ? '' : date].filter(Boolean).join(' · ');
  return `- ${link}${meta ? ` (${meta})` : ''}${supports}`;
}

function skillLine(e: ResumeEntry): string {
  const depth = e.depth ? ` _(${e.depth})_` : '';
  return `- ${escapeMd(e.text)}${depth}`;
}

export function renderMarkdown(draft: ResumeDraft, locale: 'zh-CN' | 'en' = 'zh-CN'): string {
  const copy = resumeCopy(locale);
  const lines: string[] = [];
  const contact = draft.header.contact ?? {};
  const contactParts = [
    contact.email,
    contact.phone,
    contact.location,
    contact.personalSite,
    contact.profileUrl,
  ].filter(Boolean) as string[];

  lines.push(`# ${escapeMd(draft.header.name)} — ${escapeMd(draft.header.headline)}`);
  if (contactParts.length > 0) lines.push(contactParts.map(escapeMd).join(' · '));
  lines.push('');
  lines.push(
    `**${copy.targetLabel}:** ${escapeMd(draft.targetJob.title)} @ ${escapeMd(draft.targetJob.company)}  `,
  );
  lines.push(
    `**${copy.matchLabel}:** ${draft.targetJob.tier} (${draft.targetJob.matchScore}; title ${draft.targetJob.fieldScores.title}/tags ${draft.targetJob.fieldScores.tags}/desc ${draft.targetJob.fieldScores.description})`,
  );
  lines.push('');

  lines.push(`## ${copy.summaryHeading}`);
  lines.push(escapeMd(draft.summary));
  lines.push('');

  lines.push(`## ${copy.matchedSkillsHeading}`);
  if (draft.matchedSkills.length === 0) lines.push(copy.noEntry);
  else draft.matchedSkills.forEach((e) => lines.push(skillLine(e)));
  lines.push('');

  if (draft.otherSkills.length > 0) {
    lines.push(`### ${copy.otherSkillsHeading}`);
    draft.otherSkills.forEach((e) => lines.push(skillLine(e)));
    lines.push('');
  }

  lines.push(`## ${copy.highlightsHeading}`);
  if (draft.evidenceHighlights.length === 0) lines.push(copy.noEntry);
  else draft.evidenceHighlights.forEach((e) => lines.push(entryLine(e, copy.supportsLabel)));
  lines.push('');

  if (draft.collaboration.length > 0) {
    lines.push(`## ${copy.collaborationHeading}`);
    draft.collaboration.forEach((e) => lines.push(`- ${e.url ? `[${escapeMd(e.text)}](${e.url})` : escapeMd(e.text)}`));
    lines.push('');
  }

  lines.push(`## ${copy.workHistoryHeading}`);
  if (draft.localSections.workHistory.length === 0) lines.push(copy.noEntry);
  else draft.localSections.workHistory.forEach((e) => lines.push(`- ${escapeMd(e.text)}`));
  lines.push('');

  lines.push(`## ${copy.educationHeading}`);
  if (draft.localSections.education.length === 0) lines.push(copy.noEntry);
  else draft.localSections.education.forEach((e) => lines.push(`- ${escapeMd(e.text)}`));
  lines.push('');

  if (draft.suggestions.length > 0) {
    lines.push(`## ${copy.notesHeading}`);
    draft.suggestions.forEach((s) => lines.push(`- [${s.kind}] ${escapeMd(s.text)}`));
    lines.push('');
  }

  lines.push('---');
  lines.push(
    `${copy.provenanceLabel}: profile ${draft.provenance.profileId} · analyzer ${draft.provenance.analyzerVersion} · resume-rule ${draft.provenance.ruleVersion} · ${formatDate(draft.generatedAt)}`,
  );

  return `${lines.join('\n')}\n`;
}
