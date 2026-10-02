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
  // T15：薄画像（insufficient_data/suspicious）时的诚实数据说明，投出去的交付物可见
  dataQualityNote: (status: string) => string;
  dataQualityHeading: string;
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
  dataQualityNote: (status) =>
    status === 'insufficient_data'
      ? '本简历基于公开数据生成的画像，因数据不足，部分能力与经历未经充分证实；相关陈述请以原始证据为准，面试时如实说明。'
      : '本简历基于真实性存疑的画像生成，相关陈述请务必核对原始证据后再投递。',
  dataQualityHeading: '数据说明',
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
  dataQualityNote: (status) =>
    status === 'insufficient_data'
      ? 'This resume is generated from a profile built on limited public data; some skills and experience are not fully verified. Please treat statements against the original evidence and clarify honestly in interviews.'
      : 'This resume is generated from a profile whose authenticity is in question. Verify the original evidence before submitting.',
  dataQualityHeading: 'Data notice',
};

export function resumeCopy(locale: ResumeLocale): ResumeCopy {
  return locale === 'en' ? en : zh;
}

/**
 * 求职信模板文案（阶段 1「改」的第二个交付物，设计 §3.3）。
 *
 * 与简历同一条 no-fabrication 纪律：模板只提供连接词与礼貌用语，
 * 技能名、证据 claim、岗位/公司名一律用原文事实，不在此翻译或新造。
 */
export interface CoverLetterCopy {
  /** 称呼：公司可空（自选 JD 直传时无公司） */
  greeting: (company: string) => string;
  /** 开头段：投的是哪个岗位 */
  opening: (title: string, company: string) => string;
  /** 匹配段：命中的技能 + 深度（深度词由 composeSkillDepthLabel 现拼） */
  matchLine: (skills: string) => string;
  /** 证据段：一条可直接核对的记录 */
  evidenceLine: (claim: string, url: string) => string;
  /** 收尾段 */
  close: string;
  /** 落款（姓名可空） */
  signature: (name: string) => string;
}

const coverLetterZh: CoverLetterCopy = {
  greeting: (company) => (company ? `尊敬的「${company}」招聘团队：` : '尊敬的招聘团队：'),
  opening: (title, company) =>
    company ? `我关注到贵司「${title}」职位，特此投递求职信。` : `我关注到「${title}」职位，特此投递求职信。`,
  matchLine: (skills) => `我的公开代码证据显示，我在 ${skills} 上有可回溯的实践。`,
  evidenceLine: (claim, url) => `其中一条可直接核对的记录：${claim}（${url}）。`,
  close: '期待与您进一步沟通，谢谢您的时间。',
  signature: (name) => (name ? `此致\n${name}` : '此致'),
};

const coverLetterEn: CoverLetterCopy = {
  greeting: (company) => (company ? `Dear ${company} hiring team,` : 'Dear hiring team,'),
  opening: (title, company) =>
    company
      ? `I am writing to apply for the ${title} role at ${company}.`
      : `I am writing to apply for the ${title} role.`,
  matchLine: (skills) => `My public code evidence shows verifiable hands-on work with ${skills}.`,
  evidenceLine: (claim, url) => `One record you can check directly: ${claim} (${url}).`,
  close: 'I would welcome the chance to talk further. Thank you for your time.',
  signature: (name) => (name ? `Sincerely,\n${name}` : 'Sincerely,'),
};

export function coverLetterCopy(locale: ResumeLocale): CoverLetterCopy {
  return locale === 'en' ? coverLetterEn : coverLetterZh;
}
