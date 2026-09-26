/**
 * @jobagent/resume-core：岗位定向简历纯函数内核（零 I/O，可对固定夹具单测）。
 * 设计见 docs/design-targeted-resume-20260915.md。
 */
export { buildResume } from './tailor.js';
export { polishResume } from './polish.js';
export type {
  ResumePolishProvider,
  ResumePolishEdits,
  PolishResult,
  PolishSkipReason,
} from './polish.js';
export { rankSkills, rankEvidence, normalizeName } from './rank.js';
export { parseProjectEntry, projectEntriesFromEvidence, actionLabel } from './project-entries.js';
export type { RankedSkill, RankedEvidence } from './rank.js';
export { fromJobMatch, zeroResumeMatch } from './match-input.js';
export type { JobMatchLike } from './match-input.js';
export { renderMarkdown } from './render/markdown.js';
export { renderHtml, escapeHtml } from './render/html.js';
export { resumeCopy } from './i18n.js';
export type { ResumeCopy } from './i18n.js';
export {
  DEFAULT_HIGHLIGHT_LIMIT,
  type BuildResumeInput,
  type BuildResumeOptions,
  type ResumeMatchInput,
  type ResumeMatchField,
} from './types.js';
