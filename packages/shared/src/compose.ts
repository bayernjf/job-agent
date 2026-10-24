/**
 * 画像散文的本地化 composer（从 index.ts 拆出，审查动作 #8）。
 * 渲染侧只认 code 与 facts，绝不按英文句子匹配；取不到的事实不许编。
 */
import type { InterviewQuestionKind, SkillTagDepth } from './evidence.js';
import type { ResumeLocale } from './locale.js';
import type { AbilityProfile, ImprovementSuggestionCode, SupportedPlatform } from './profile.js';

/**
 * headline 文案组装（T07，2026-09-25）。
 *
 * 快照里的 `summary.headline` 是**数据层英文原文**；面向读者的表面（报告页、简历、面试包）
 * 按读者语言现拼。模板与取法放本文件，是为了让分析内核与渲染侧共用同一套事实取法——
 * 分两处写迟早漂移成两种口径。
 * 只组装不改口径：缺哪个事实就整段省略，绝不产出 "with 0 public repos" 这类空话。
 * **不前缀 login**：本句是"身份之外的角色描述"，姓名/账号由各处标题行自己带；
 * 带上就会和 `# {name} — {headline}` 这类模板拼成 "alice — alice — …"。
 */
export interface HeadlineFacts {
  platform: SupportedPlatform;
  /** 主力语言（最高置信度 language 标签）；缺省时退化为「{平台} 开发者」 */
  language?: string | null;
  /** 公开仓库数；缺省时省略该片段 */
  repoCount?: number | null;
  /** 持续活跃月数；缺省时省略该片段 */
  months?: number | null;
}

const PLATFORM_DISPLAY: Record<SupportedPlatform, string> = { github: 'GitHub', gitee: 'Gitee' };

/** 从画像快照取 headline 事实；与 analyze 内部写快照时用的是同一批字段 */
export function headlineFactsFromProfile(
  profile: Pick<AbilityProfile, 'subject' | 'skillTags' | 'activity'>,
): HeadlineFacts {
  return {
    platform: profile.subject.platform,
    language: profile.skillTags.find((tag) => tag.kind === 'language')?.name ?? null,
    repoCount: profile.activity.metrics?.totalRepos ?? null,
    months: profile.activity.longevityMonths ?? null,
  };
}

/** 一句话定位：中英各一套模板，平台名按画像主体取（Gitee 主体不再被写成 GitHub） */
export function composeHeadline(facts: HeadlineFacts, locale: ResumeLocale): string {
  const platform = PLATFORM_DISPLAY[facts.platform];
  const english = locale === 'en';
  const language = facts.language?.trim();
  const role = language
    ? english ? `${language} developer` : `${language} 开发者`
    : english ? `${platform} developer` : `${platform} 开发者`;

  const clauses: string[] = [];
  const repos = facts.repoCount;
  if (typeof repos === 'number' && repos > 0) {
    clauses.push(english ? `${repos} public repo${repos === 1 ? '' : 's'}` : `${repos} 个公开仓库`);
  }
  const months = facts.months;
  if (typeof months === 'number' && months > 0) {
    clauses.push(
      english ? `${months} months of ${platform} activity` : `在 ${platform} 持续活跃 ${months} 个月`,
    );
  }

  return english
    ? clauses.length === 0
      ? role
      : `${role} with ${clauses.join(' and ')}`
    : [role, ...clauses].join('，');
}

/**
 * 改进建议文案（T10）：按 code 取，中英同构，随读者语言渲染。
 * 刻意只写"能从画像事实直接支撑的下一步动作"，不掺鼓励性套话；
 * 事实与证据仍由内核与快照负责，这里不新增任何判断。
 */
const IMPROVEMENT_COPY: Record<
  ImprovementSuggestionCode,
  Record<ResumeLocale, { suggestion: string; why: string }>
> = {
  no_pull_requests: {
    en: {
      suggestion: 'Move your work into pull requests: open a PR for changes you keep committing locally, and go through review.',
      why: 'The recorded commits all sit in your own repositories and no pull request was opened, so there is no evidence of working inside a review process.',
    },
    "zh-CN": {
      suggestion: '把改动放进 PR：给一直在自己仓库里提交的变更开一个 PR，走完一轮 code review。',
      why: '记录里的提交都落在自有仓库，且没有开过 PR，因此拿不到"在评审流程里协作"的证据。',
    },
  },
  no_external_contributions: {
    en: {
      suggestion: 'Land one contribution outside your own repositories: pick a project you actually use and open a PR there.',
      why: 'Pull requests exist, but none were merged into someone else\'s repository — a PR accepted by an external maintainer is the hardest-to-fake collaboration signal we can show.',
    },
    "zh-CN": {
      suggestion: '做一项仓库外的贡献：挑一个你真正在用的项目，给它提一个 PR。',
      why: '已有 PR，但没有一项落到别人的仓库并被合并——被外部维护者接受的 PR 是最难伪造的协作证据。',
    },
  },
};

export function composeImprovementSuggestion(
  code: ImprovementSuggestionCode,
  locale: ResumeLocale,
): { suggestion: string; why: string } {
  return IMPROVEMENT_COPY[code][locale];
}

/**
 * 内核枚举与计数 → 读者语言（T23）。
 * 与 `composeHeadline` 同一条纪律：事实留在快照里，句子按读者语言现拼；
 * 取不到的事实一律不编（宁可退回快照的英文原句），否则中文交付物会写出画像里没有的数字。
 */

const SKILL_DEPTH_LABELS: Record<SkillTagDepth, Record<ResumeLocale, string>> = {
  used: { en: 'used', "zh-CN": '使用过' },
  proficient: { en: 'proficient', "zh-CN": '有深度' },
};

export function composeSkillDepthLabel(depth: SkillTagDepth, locale: ResumeLocale): string {
  return SKILL_DEPTH_LABELS[depth][locale];
}

const SENIORITY_BAND_LABELS: Record<string, Record<ResumeLocale, string>> = {
  junior: { en: 'junior', "zh-CN": '初级' },
  mid: { en: 'mid-level', "zh-CN": '中级' },
  senior: { en: 'senior', "zh-CN": '资深' },
};

/** 档位内核只产三档，但快照里是开放 string（历史画像可能存别的值），未知值原样返回不臆译。 */
export function composeSeniorityBand(band: string, locale: ResumeLocale): string {
  return SENIORITY_BAND_LABELS[band]?.[locale] ?? band;
}

export interface PrSummaryFacts {
  opened: number;
  merged: number;
  /** 合入他人仓库的 PR 数；缺省即整段省略（不能用 externalMergedContributions 的长度代替，那是去重后的仓库数） */
  externalMerged?: number | null;
}

/**
 * 从快照取 PR 计数。`activity.metrics` 的两个计数由内核直接写入，
 * 但**外部 merged PR 数今天不在快照里**（只有 ≤5 个去重仓库名），所以本函数不返回它——
 * 报告页要连那一段一起本地化，需要内核先把该计数补进 metrics（见 handoff T33）。
 */
export function prSummaryFactsFromProfile(
  profile: Pick<AbilityProfile, 'activity'>,
): PrSummaryFacts | null {
  const opened = profile.activity.metrics?.totalPullRequests;
  const merged = profile.activity.metrics?.mergedPullRequests;
  if (typeof opened !== 'number' || typeof merged !== 'number') return null;
  // T33：内核已把 externalMergedPullRequests 写进 metrics；旧快照没有该键时按 null 处理
  // （句子自动省略该片段，而不是猜一个数）。
  const externalMerged = profile.activity.metrics?.externalMergedPullRequests;
  return {
    opened,
    merged,
    ...(typeof externalMerged === 'number' ? { externalMerged } : {}),
  };
}

/** 分析内核写快照时用同一函数，故 'en' 分支与快照里的英文原句逐字节一致。 */
export function composePrSummary(facts: PrSummaryFacts, locale: ResumeLocale): string {
  const external =
    typeof facts.externalMerged === 'number' && facts.externalMerged > 0 ? facts.externalMerged : 0;
  if (locale === 'en') {
    return `${facts.opened} PR(s) opened, ${facts.merged} merged${
      external > 0 ? `, ${external} into external projects` : ''
    }`;
  }
  return `开过 ${facts.opened} 个 PR，合并 ${facts.merged} 个${
    external > 0 ? `，其中 ${external} 个合入他人仓库` : ''
  }`;
}

/**
 * 信号文案现拼（T33）。label/detail 在快照里是数据层英文原文（存档/API 以此为准）；
 * 面向读者的表面（报告页、面试准备包）按 code + facts 现拼。
 * 三条纪律：
 * 1. 渲染分支只认 code，绝不按英文 label/detail 匹配；
 * 2. facts 缺关键数字时退回快照英文原句（signal.detail / signal.label），绝不猜数；
 * 3. 新增 code 只需在此登记模板，内核不感知渲染语言。
 */

type SignalFactsRecord = Record<string, string | number | boolean>;

const SIGNAL_LABELS: Record<string, Record<ResumeLocale, string>> = {
  'r0.1.sig.author_inconsistency': { en: 'Commit author identity does not match the claimed account', "zh-CN": '提交作者身份与账号不一致' },
  'r0.1.sig.commit_burst': { en: 'Commit burst followed by long silence', "zh-CN": '提交突发且前后长期沉默' },
  'r0.1.sig.stale_activity': { en: 'No activity in the last year', "zh-CN": '近期无活动' },
  'r0.1.sig.star_activity_mismatch': { en: 'Star count exceeds commit activity', "zh-CN": 'star 数与提交活跃度不匹配' },
  'r0.1.sig.empty_activity': { en: 'Not enough behavioral evidence', "zh-CN": '行为证据不足' },
  'r0.1.sig.short_longevity': { en: 'Short activity span', "zh-CN": '活动跨度过短' },
  'r0.1.sig.external_contributions': { en: 'Merged contributions to external projects', "zh-CN": '合入他人项目的贡献' },
  'r0.1.sig.low_diversity': { en: 'Single-language portfolio', "zh-CN": '语言单一的作品集' },
  'r0.1.sig.star_to_commit_ratio': { en: 'Star count disproportionately high relative to commit activity', "zh-CN": 'star 与提交比例异常' },
  'r0.1.sig.self_pr_ratio': { en: 'Nearly all pull requests are in self-owned repos', "zh-CN": 'PR 几乎全在自有仓库' },
  'r0.2.sig.narrow_activity_scope': { en: 'Activity concentrated in a single repository with little collaboration', "zh-CN": '活动集中于单一仓库且协作痕迹少' },
};

/** 信号标题本地化；未知 code 退回快照英文原标题（en 不变原则：渲染侧绝不臆译）。 */
export function composeSignalLabel(
  code: string,
  locale: ResumeLocale,
  fallbackLabel: string,
): string {
  return SIGNAL_LABELS[code]?.[locale] ?? fallbackLabel;
}

function num(f: SignalFactsRecord | undefined, key: string): number | undefined {
  const v = f?.[key];
  return typeof v === 'number' ? v : undefined;
}

/** 信号描述本地化：facts 齐全按模板现拼，缺关键数字退回快照英文原句。 */
export function composeSignalDetail(
  code: string,
  locale: ResumeLocale,
  fallbackDetail: string,
  facts?: SignalFactsRecord,
): string {
  const en = locale === 'en';
  const pct = (v: number | undefined) => (typeof v === 'number' ? Math.round(v) : undefined);
  switch (code) {
    case 'r0.1.sig.author_inconsistency': {
      const em = pct(num(facts, 'emailMatchPct'));
      const nm = pct(num(facts, 'nameMatchPct'));
      if (typeof em === 'number' && typeof nm === 'number') {
        return en
          ? `Only ${em}% of commits use the account's public email and only ${nm}% match its identity`
          : `只有 ${em}% 的提交使用账号公开邮箱，仅 ${nm}% 与账号身份匹配`;
      }
      if (typeof em === 'number') {
        return en
          ? `Only ${em}% of sampled commits use the account's public email (private/noreply email is common)`
          : `仅 ${em}% 的抽样提交使用账号公开邮箱（隐私/无回复邮箱很常见）`;
      }
      if (typeof nm === 'number') {
        return en
          ? `Only ${nm}% of sampled commit author names match the GitHub login or display name`
          : `仅 ${nm}% 的抽样提交作者名与账号身份匹配`;
      }
      return fallbackDetail;
    }
    case 'r0.1.sig.commit_burst': {
      const commits = num(facts, 'commits');
      const month = facts?.month;
      if (typeof commits === 'number' && typeof month === 'string') {
        return en
          ? `${commits} commits in ${month} with no commits in adjacent months`
          : `${month} 月内 ${commits} 个提交，相邻月份无提交`;
      }
      return fallbackDetail;
    }
    case 'r0.1.sig.stale_activity': {
      const monthsAgo = num(facts, 'monthsAgo');
      if (typeof monthsAgo === 'number') {
        return en
          ? `Latest GitHub activity was ${monthsAgo} months ago`
          : `最近的 GitHub 活动在 ${monthsAgo} 个月前`;
      }
      return fallbackDetail;
    }
    case 'r0.1.sig.star_activity_mismatch': {
      const stars = num(facts, 'stars');
      const cc = num(facts, 'commitContributions');
      if (typeof stars === 'number' && typeof cc === 'number') {
        return en
          ? `${stars} stars across repos but only ${cc} commit contributions in the last year`
          : `仓库合计 ${stars} 个 star，但近一年仅 ${cc} 次提交贡献`;
      }
      return fallbackDetail;
    }
    case 'r0.1.sig.star_to_commit_ratio': {
      const stars = num(facts, 'stars');
      const commits = num(facts, 'commits');
      const ratio = num(facts, 'ratio');
      const established = facts?.established === true;
      if (typeof stars === 'number' && typeof commits === 'number' && typeof ratio === 'number') {
        return en
          ? `${stars} stars across ${commits} sampled commits (ratio ${Math.round(ratio)}:1); ${
              established
                ? 'high but the account is long-lived with real collaboration, so treat as a maintainer profile and review manually'
                : 'may indicate purchased stars or forked high-profile repos'
            }`
          : `${commits} 个抽样提交对应 ${stars} 个 star（比例 ${Math.round(ratio)}:1）；${
              established
                ? '比例偏高但账号长期活跃且有真实协作，按维护者画像看待，建议人工复核'
                : '可能指向购买 star 或搬运高星项目'
            }`;
      }
      return fallbackDetail;
    }
    case 'r0.1.sig.empty_activity': {
      const bt = num(facts, 'behaviorTotal');
      const cc = num(facts, 'commitContributions');
      if (typeof bt === 'number' && typeof cc === 'number') {
        return en
          ? `Only ${bt} commit/PR/issue records and ${cc} commit contributions`
          : `只有 ${bt} 条 commit/PR/Issue 记录与 ${cc} 次提交贡献`;
      }
      return fallbackDetail;
    }
    case 'r0.1.sig.short_longevity': {
      const months = num(facts, 'months');
      if (typeof months === 'number') {
        return en
          ? `GitHub activity spans about ${Math.max(1, months)} months`
          : `GitHub 活动跨度约 ${Math.max(1, months)} 个月`;
      }
      return fallbackDetail;
    }
    case 'r0.1.sig.external_contributions': {
      const count = num(facts, 'externalMergedCount');
      const strong = facts?.strong === true;
      if (typeof count === 'number') {
        return en
          ? `${count} pull request(s) merged into projects not owned by the account (${strong ? 'strong positive signal' : 'weak positive signal'})`
          : `${count} 个 PR 合入了非账号自有的项目（${strong ? '强正向信号' : '弱正向信号'}）`;
      }
      return fallbackDetail;
    }
    case 'r0.1.sig.self_pr_ratio': {
      const self = num(facts, 'selfCount');
      const total = num(facts, 'total');
      if (typeof self === 'number' && typeof total === 'number') {
        return en
          ? `${self} of ${total} pull requests (${Math.round((self / total) * 100)}%) are in self-owned repos; may indicate inflated PR count`
          : `${total} 个 PR 中有 ${self} 个（${Math.round((self / total) * 100)}%）在自有仓库；可能指数量虚高`;
      }
      return fallbackDetail;
    }
    case 'r0.1.sig.low_diversity': {
      const repoCount = num(facts, 'repoCount');
      const language = facts?.language;
      if (typeof repoCount === 'number' && typeof language === 'string') {
        return en
          ? `${repoCount} repos but only ${language} primary language`
          : `${repoCount} 个仓库但主要语言只有 ${language}`;
      }
      return fallbackDetail;
    }
    case 'r0.2.sig.narrow_activity_scope': {
      const share = pct(num(facts, 'top1CommitSharePct'));
      const prCount = num(facts, 'prCount');
      const eventTypeCount = num(facts, 'eventTypeCount');
      const distinctRepoCount = num(facts, 'distinctRepoCount');
      if (typeof share === 'number' && typeof prCount === 'number') {
        if (typeof eventTypeCount === 'number' && typeof distinctRepoCount === 'number') {
          return en
            ? `${share}% of sampled commits are in one repository, with fewer than ${prCount === 3 ? '3' : prCount} PRs, no externally merged PR, and only ${eventTypeCount} public event type(s) across ${distinctRepoCount} repo(s)`
            : `${share}% 的抽样提交集中在单一仓库，PR 少于 ${prCount} 个、无外部合并 PR，公共事件类型仅 ${eventTypeCount} 种、覆盖 ${distinctRepoCount} 个仓库`;
        }
        return en
          ? `${share}% of sampled commits are in one repository, with fewer than ${prCount === 3 ? '3' : prCount} PRs and no externally merged PR`
          : `${share}% 的抽样提交集中在单一仓库，PR 少于 ${prCount} 个且无外部合并 PR`;
      }
      return fallbackDetail;
    }
    default:
      return fallbackDetail;
  }
}

const INTERVIEW_INTENT_COPY: Record<InterviewQuestionKind, Record<ResumeLocale, string>> = {
  self_repo_depth: {
    en: 'Assess depth of ownership and engineering judgment on real work',
    "zh-CN": '考察真实工作上的所有权深度与工程判断',
  },
  external_pr: {
    en: 'Assess collaboration skills and engineering judgment in external codebases',
    "zh-CN": '考察在外部代码库中的协作能力与工程判断',
  },
  high_star_design: {
    en: 'Assess system design and community impact',
    "zh-CN": '考察系统设计与社区影响力',
  },
  language_depth: {
    en: 'Assess language depth beyond syntax familiarity',
    "zh-CN": '考察超出语法熟悉度的语言深度',
  },
  issue_diagnosis: {
    en: 'Assess debugging and problem-analysis ability',
    "zh-CN": '考察问题诊断与调试能力',
  },
};

/** 面试题意图本地化；未知 kind 原样退回快照英文 intent。 */
export function composeInterviewIntent(
  kind: InterviewQuestionKind | undefined,
  locale: ResumeLocale,
  fallbackIntent: string,
): string {
  if (!kind) return fallbackIntent;
  return INTERVIEW_INTENT_COPY[kind]?.[locale] ?? fallbackIntent;
}

/** cadenceSummary 本地化：从 metrics 现拼"X commits/month across Y active months"。 */
export function composeCadenceSummary(
  facts: { commits: number; months: number },
  locale: ResumeLocale,
): string {
  const rate = (facts.commits / facts.months).toFixed(1);
  return locale === 'en'
    ? `${rate} commits/month across ${facts.months} active months`
    : `平均每月 ${rate} 次提交，共活跃 ${facts.months} 个月`;
}
