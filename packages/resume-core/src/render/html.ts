/**
 * 简历 HTML 渲染（纯函数、ATS/打印友好）。
 * - 独立可移植 HTML：:root 内联设计 token（取值与 packages/ui-tokens/tokens.css 同步），
 *   组件样式只消费 var(--ja-*)，不散落 hex；
 * - @media print 适配 A4，浏览器"打印→另存 PDF"即可，不引 puppeteer；
 * - 所有外部文本经 escapeHtml，防 claim/补填文本注入。
 */
import type { ResumeDraft, ResumeEntry } from '@jobagent/shared';
import { resumeCopy } from '../i18n.js';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

const TIER_COLOR: Record<ResumeDraft['targetJob']['tier'], string> = {
  high: 'var(--ja-color-green-600)',
  mid: 'var(--ja-color-amber-600)',
  low: 'var(--ja-color-neutral-500)',
};

function skillItems(list: ResumeEntry[]): string {
  if (list.length === 0) return '<p class="muted">&mdash;</p>';
  return `<ul>${list
    .map((e) => `<li><code>${escapeHtml(e.text)}</code>${e.depth ? ` <span class="muted">(${escapeHtml(e.depth)})</span>` : ''}</li>`)
    .join('')}</ul>`;
}

function evidenceItems(list: ResumeEntry[], supportsLabel: string): string {
  if (list.length === 0) return '<p class="muted">&mdash;</p>';
  return `<ul>${list
    .map((e) => {
      const body = e.url
        ? `<a href="${escapeHtml(e.url)}" rel="noopener noreferrer">${escapeHtml(e.text)}</a>`
        : escapeHtml(e.text);
      const date = formatDate(e.occurredAt);
      const supports = e.supportsSkills.length
        ? ` <span class="muted">(${escapeHtml(supportsLabel)}: ${e.supportsSkills.map(escapeHtml).join(', ')})</span>`
        : '';
      return `<li>${body}${date ? ` <span class="muted">${date}</span>` : ''}${supports}</li>`;
    })
    .join('')}</ul>`;
}

function localItems(list: ResumeEntry[]): string {
  if (list.length === 0) return '<p class="muted">&mdash;</p>';
  return `<ul>${list.map((e) => `<li>${escapeHtml(e.text)}</li>`).join('')}</ul>`;
}

export function renderHtml(draft: ResumeDraft, locale: 'zh-CN' | 'en' = 'zh-CN'): string {
  const copy = resumeCopy(locale);
  const contact = draft.header.contact ?? {};
  const contactParts = [
    contact.email,
    contact.phone,
    contact.location,
    contact.personalSite,
    contact.linkedinUrl,
    contact.profileUrl,
  ]
    .filter(Boolean)
    .map((v) => escapeHtml(v as string));
  const tj = draft.targetJob;

  return `<!DOCTYPE html>
<html lang="${locale === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(draft.header.name)} — ${escapeHtml(tj.company ? `${tj.title} @ ${tj.company}` : tj.title)}</title>
<style>
  /* token values synced from packages/ui-tokens/tokens.css (single source of truth) */
  :root {
    --ja-color-neutral-0:#ffffff; --ja-color-neutral-50:#f8fafc; --ja-color-neutral-200:#e2e8f0;
    --ja-color-neutral-500:#64748b; --ja-color-neutral-700:#334155; --ja-color-neutral-900:#0f172a;
    --ja-color-green-600:#15803d; --ja-color-amber-600:#d97706; --ja-color-blue-600:#2563eb;
    --ja-space-1:4px; --ja-space-2:8px; --ja-space-3:12px; --ja-space-4:16px; --ja-space-5:24px;
    --ja-radius-md:8px; --ja-font-sans:'Inter','PingFang SC','Microsoft YaHei',system-ui,-apple-system,sans-serif;
  }
  * { box-sizing: border-box; }
  body { font-family: var(--ja-font-sans); max-width: 820px; margin: var(--ja-space-5) auto; padding: 0 var(--ja-space-4);
         color: var(--ja-color-neutral-900); line-height: 1.6; background: var(--ja-color-neutral-0); }
  h1 { font-size: 1.6rem; margin: 0 0 var(--ja-space-1); }
  h2 { font-size: 1.1rem; margin: var(--ja-space-5) 0 var(--ja-space-2); padding-bottom: var(--ja-space-1);
       border-bottom: 1px solid var(--ja-color-neutral-200); color: var(--ja-color-neutral-700); }
  h3 { font-size: .98rem; margin: var(--ja-space-3) 0 var(--ja-space-1); }
  code { background: var(--ja-color-neutral-50); padding: .1em .4em; border-radius: var(--ja-radius-md); font-size: .92em; }
  a { color: var(--ja-color-blue-600); text-decoration: none; }
  ul { padding-left: 1.3rem; margin: var(--ja-space-1) 0; }
  .headline { color: var(--ja-color-neutral-700); margin: 0 0 var(--ja-space-2); }
  .contact { color: var(--ja-color-neutral-500); font-size: .92rem; }
  .target { background: var(--ja-color-neutral-50); border: 1px solid var(--ja-color-neutral-200);
            border-radius: var(--ja-radius-md); padding: var(--ja-space-2) var(--ja-space-3); margin: var(--ja-space-3) 0; font-size: .94rem; }
  .tier { font-weight: 700; color: ${TIER_COLOR[tj.tier]}; }
  .muted { color: var(--ja-color-neutral-500); font-size: .9em; }
  .suggestions li { font-size: .92rem; }
  footer { margin-top: var(--ja-space-5); padding-top: var(--ja-space-2); border-top: 1px solid var(--ja-color-neutral-200);
           color: var(--ja-color-neutral-500); font-size: .82rem; }
  @page { size: A4; margin: 14mm; }
  @media print {
    body { margin: 0; max-width: none; }
    a { color: var(--ja-color-neutral-900); text-decoration: none; }
    code, .target { background: transparent; border: none; padding: 0; }
    h2 { break-after: avoid; } li { break-inside: avoid; }
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(draft.header.name)}</h1>
<p class="headline">${escapeHtml(draft.header.headline)}</p>
<p class="contact">${contactParts.join(' · ')}</p>

<div class="target">
  <strong>${copy.targetLabel}:</strong> ${escapeHtml(tj.company ? `${tj.title} @ ${tj.company}` : tj.title)}
  &nbsp;|&nbsp; <strong>${copy.matchLabel}:</strong> <span class="tier">${escapeHtml(tj.tier)}</span>
  (${tj.matchScore}; title ${tj.fieldScores.title} / tags ${tj.fieldScores.tags} / desc ${tj.fieldScores.description})
  &nbsp;·&nbsp; <a href="${escapeHtml(tj.sourceUrl)}" rel="noopener noreferrer">${copy.targetLabel}</a>
</div>

<h2>${copy.summaryHeading}</h2>
<p>${escapeHtml(draft.summary)}</p>

<h2>${copy.matchedSkillsHeading}</h2>
${skillItems(draft.matchedSkills)}
${draft.otherSkills.length ? `<h3>${copy.otherSkillsHeading}</h3>${skillItems(draft.otherSkills)}` : ''}

<h2>${copy.highlightsHeading}</h2>
${evidenceItems(draft.evidenceHighlights, copy.supportsLabel)}

${
  draft.collaboration.length
    ? `<h2>${copy.collaborationHeading}</h2><ul>${draft.collaboration
        .map((e) =>
          e.url
            ? `<li><a href="${escapeHtml(e.url)}">${escapeHtml(e.text)}</a></li>`
            : `<li>${escapeHtml(e.text)}</li>`,
        )
        .join('')}</ul>`
    : ''
}

<h2>${copy.workHistoryHeading}</h2>
${localItems(draft.localSections.workHistory)}

<h2>${copy.educationHeading}</h2>
${localItems(draft.localSections.education)}

${
  draft.suggestions.length
    ? `<h2>${copy.notesHeading}</h2><ul class="suggestions">${draft.suggestions
        .map((s) => `<li>[${escapeHtml(s.kind)}] ${escapeHtml(s.text)}</li>`)
        .join('')}</ul>`
    : ''
}

<footer>${copy.provenanceLabel}: profile ${escapeHtml(draft.provenance.profileId)} · analyzer ${escapeHtml(
    draft.provenance.analyzerVersion,
  )} · resume-rule ${escapeHtml(draft.provenance.ruleVersion)} · ${formatDate(draft.generatedAt)}</footer>
</body>
</html>
`;
}
