/**
 * 简历 Markdown 渲染（纯函数、ATS 友好：单栏、标准标题、无表格布局）。
 * 所有外部文本做最小转义，防止 claim/补填文本破坏 Markdown 结构。
 *
 * 交付物卫生（T12）：匹配分分解、`[missing_*]` 改进提示、provenance 脚注**不进本文件**——
 * 那些是给产品界面看的调试面，投出去的文件里只留简历本身。
 */
import {
  composeSkillDepthLabel,
  type ProjectEntry,
  type ResumeDraft,
  type ResumeEntry,
  type ResumeLocale,
} from '@jobagent/shared';
import { actionLabel } from '../project-entries.js';
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

function projectLine(e: ProjectEntry): string {
  const date = formatDate(e.occurredAt);
  const label = `${actionLabel(e.action)} ${escapeMd(e.title)}`;
  const link = `[${label}](${e.url})`;
  const parts = [escapeMd(e.project), e.scale ? escapeMd(e.scale) : '', date]
    .filter(Boolean)
    .join(' · ');
  return `- ${link} (${parts})`;
}

function skillLine(e: ResumeEntry, locale: ResumeLocale): string {
  const depth = e.depth ? ` _(${composeSkillDepthLabel(e.depth, locale)})_` : '';
  return `- ${escapeMd(e.text)}${depth}`;
}

export function renderMarkdown(draft: ResumeDraft, locale: ResumeLocale = 'zh-CN'): string {
  const copy = resumeCopy(locale);
  const lines: string[] = [];
  const contact = draft.header.contact ?? {};
  const contactParts = [
    contact.email,
    contact.phone,
    contact.location,
    contact.personalSite,
    contact.linkedinUrl,
    contact.profileUrl,
  ].filter(Boolean) as string[];

  lines.push(`# ${escapeMd(draft.header.name)} — ${escapeMd(draft.header.headline)}`);
  if (contactParts.length > 0) lines.push(contactParts.map(escapeMd).join(' · '));
  lines.push('');
  lines.push(
    `**${copy.targetLabel}:** ${
      draft.targetJob.company
        ? `${escapeMd(draft.targetJob.title)} @ ${escapeMd(draft.targetJob.company)}`
        : escapeMd(draft.targetJob.title)
    }  `,
  );
  lines.push('');

  lines.push(`## ${copy.summaryHeading}`);
  lines.push(escapeMd(draft.summary));
  lines.push('');

  lines.push(`## ${copy.matchedSkillsHeading}`);
  if (draft.matchedSkills.length === 0) lines.push(copy.noEntry);
  else draft.matchedSkills.forEach((e) => lines.push(skillLine(e, locale)));
  lines.push('');

  if (draft.otherSkills.length > 0) {
    lines.push(`### ${copy.otherSkillsHeading}`);
    draft.otherSkills.forEach((e) => lines.push(skillLine(e, locale)));
    lines.push('');
  }

  lines.push(`## ${copy.highlightsHeading}`);
  if (draft.evidenceHighlights.length === 0) lines.push(copy.noEntry);
  else draft.evidenceHighlights.forEach((e) => lines.push(entryLine(e, copy.supportsLabel)));
  lines.push('');

  if ((draft.projectEntries?.length ?? 0) > 0) {
    lines.push(`## ${copy.projectsHeading}`);
    draft.projectEntries.forEach((e) => lines.push(projectLine(e)));
    lines.push('');
  }

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

  return `${lines.join('\n')}\n`;
}
