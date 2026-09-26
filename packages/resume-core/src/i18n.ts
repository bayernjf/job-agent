/**
 * 简历模板固定文案（中英双语）。
 * 注意：这里只放"连接词/区块标题"等模板词；所有事实（技能、数字、经历、岗位名）
 * 保持画像/岗位原文，不在此翻译或新造。
 */
import type { ResumeLocale } from '@jobagent/shared';

export interface ResumeCopy {
  targetLabel: string; // 目标岗位
  summaryHeading: string;
  matchedSkillsHeading: string;
  otherSkillsHeading: string;
  highlightsHeading: string;
  projectsHeading: string;
  collaborationHeading: string;
  workHistoryHeading: string;
  educationHeading: string;
  selfProvidedTag: string; // 本地补填标记
  supportsLabel: string;
  /** summary 组装：headline + 目标岗位 + top 命中技能 */
  summaryTargeting: (jobTitle: string, company: string, topSkills: string) => string;
  /** 协作片段（external merged 数量），无则空串 */
  collaborationPhrase: (externalMergedCount: number) => string;
  /** 量化句（T14）：三个数都来自 activity.metrics，缺任一整句省略（不写半句、不造数） */
  quantifiedLine: (mergedPrs: number, activeRepos: number, months: number) => string;
  // suggestions / gaps 文案
  missingSkill: (skill: string) => string;
  missingField: (field: string) => string;
  lowMatch: (tier: string, score: number) => string;
  gapField: string; // 教育
  gapWork: string;
  gapContact: string;
  fieldLabels: { email: string; phone: string; location: string; personalSite: string; education: string; workHistory: string };
  noEntry: string; // 空区块占位
}

const zh: ResumeCopy = {
  targetLabel: '目标岗位',
  summaryHeading: '个人概述',
  matchedSkillsHeading: '岗位匹配技能',
  otherSkillsHeading: '其他技能',
  highlightsHeading: '项目与证据（可回溯）',
  projectsHeading: '项目经历',
  collaborationHeading: '协作与外部贡献',
  workHistoryHeading: '工作经历（本人补填）',
  educationHeading: '教育经历（本人补填）',
  selfProvidedTag: '本人补填',
  supportsLabel: '支撑技能',
  summaryTargeting: (title, company, top) =>
    `本次目标岗位「${title} @ ${company}」，重点突出 ${top}`,
  collaborationPhrase: (n) => (n > 0 ? `有 ${n} 项被外部仓库合并的贡献。` : ''),
  quantifiedLine: (prs, repos, months) => `已合并 ${prs} 个 PR，覆盖 ${repos} 个活跃仓库，持续 ${months} 个月。`,
  missingSkill: (s) => `岗位提及「${s}」，画像未检出；如确有经验请在本地补填中说明，切勿虚构。`,
  missingField: (f) => `缺少${f}，建议补填以形成完整简历。`,
  lowMatch: (tier, score) => `该岗位匹配度为 ${tier}（${score} 分），可优先选择更高匹配岗位或补充相关证据。`,
  gapField: '教育经历',
  gapWork: '工作经历',
  gapContact: '联系方式（邮箱）',
  fieldLabels: {
    email: '邮箱',
    phone: '电话',
    location: '所在地',
    personalSite: '个人站点',
    education: '教育经历',
    workHistory: '工作经历',
  },
  noEntry: '（暂无）',
};

const en: ResumeCopy = {
  targetLabel: 'Target',
  summaryHeading: 'Summary',
  matchedSkillsHeading: 'Skills matched to this role',
  otherSkillsHeading: 'Other skills',
  highlightsHeading: 'Highlights (verifiable evidence)',
  projectsHeading: 'Projects',
  collaborationHeading: 'Collaboration & external contributions',
  workHistoryHeading: 'Work history (self-provided)',
  educationHeading: 'Education (self-provided)',
  selfProvidedTag: 'self-provided',
  supportsLabel: 'supports',
  summaryTargeting: (title, company, top) =>
    `Targeting "${title} @ ${company}", with emphasis on ${top}.`,
  collaborationPhrase: (n) => (n > 0 ? `${n} contribution(s) merged into external repositories.` : ''),
  quantifiedLine: (prs, repos, months) =>
    `Merged ${prs} pull request(s) across ${repos} active repositories over ${months} months.`,
  missingSkill: (s) =>
    `The role mentions "${s}", which is not evidenced in the profile; add it locally only if true — never fabricate.`,
  missingField: (f) => `${f} is missing; add it locally for a complete resume.`,
  lowMatch: (tier, score) =>
    `Match level for this role is ${tier} (score ${score}); prefer a better-matching role or add relevant evidence.`,
  gapField: 'education',
  gapWork: 'work history',
  gapContact: 'contact (email)',
  fieldLabels: {
    email: 'email',
    phone: 'phone',
    location: 'location',
    personalSite: 'personal site',
    education: 'education',
    workHistory: 'work history',
  },
  noEntry: '(none)',
};

export function resumeCopy(locale: ResumeLocale): ResumeCopy {
  return locale === 'en' ? en : zh;
}
