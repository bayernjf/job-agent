/**
 * github-source：GitHub 证据源（EvidenceSource 首个实现）。
 *
 * 职责：用官方 Octokit（GraphQL 批量优先、REST 补）采集账号的 L0 元数据与
 * L1 行为时序，产出 analyzer-core 可直接消费的 AnalyzerInput 与 EvidenceItem 列表。
 *
 * 约束（docs/技术选型-MVP-20260910.md 6.7）：
 * - 凭证只在服务端/环境变量，绝不下发前端、不入 Git；
 * - 单画像调用预算、限频自动退避、剩余额度监控、缓存命中优先；
 * - 任一层失败显式标注缺失，禁止输出"看似完整"的数据。
 */

import type { AnalyzerInput } from '@jobagent/analyzer-core';
import type { EvidenceItem } from '@jobagent/shared';

/** 一次采集的全部产出：分析输入 + 证据 + 元信息 */
export interface GitHubCollectedData {
  input: AnalyzerInput;
  evidence: EvidenceItem[];
  meta: {
    /** 本次采集实际消耗：GraphQL 点数与 REST 调用次数 */
    budgetUsed: { graphqlPoints: number; restCalls: number };
    /** 显式缺失标注（如提交获取失败、账号不存在）；空数组表示无缺失 */
    missing: string[];
  };
}

/** 单画像调用预算（技术选型 S1 spike 后回填实测区间；先给保守默认） */
export interface ProfileBudget {
  /** GraphQL 点预算（默认 1500 点，约为认证配额 5000 点的 30%） */
  graphqlPoints: number;
  /** REST 调用次数预算（默认 120 次） */
  restCalls: number;
}

export interface GitHubSourceOptions {
  /** 访问令牌：本地 PAT / GitHub App token（必填，服务端持有） */
  token: string;
  budget?: Partial<ProfileBudget>;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** 自定义 fetch（测试注入用；默认 Node 全局 fetch） */
  fetch?: typeof fetch;
  /** 关闭限频器（测试/fake 场景用；生产保持 true） */
  throttleEnabled?: boolean;
}

/** L0 元数据（不含行为时序） */
export interface L0Data {
  subject: AnalyzerInput['subject'];
  repos: AnalyzerInput['repos'];
  contributions: AnalyzerInput['contributions'];
  dataWindow: AnalyzerInput['dataWindow'];
}

/** L1 行为时序 */
export interface L1Data {
  commits: AnalyzerInput['commits'];
  pullRequests: AnalyzerInput['pullRequests'];
  issues: AnalyzerInput['issues'];
}
