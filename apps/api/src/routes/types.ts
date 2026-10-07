/**
 * API 层共享类型（从原 index.ts 抽出，Q1 单文件拆分）。
 * 测试仍从 `../index.js` 导入（index.ts re-export 本文件），保持调用方不变。
 */
import type {
  IAccountsRepository,
  IAnalysisJobsRepository,
  IApplicationsRepository,
  IInterviewsRepository,
  IAuthSessionsRepository,
  IDemoSessionsRepository,
  ILlmCatalogRepository,
  IProfilesRepository,
  IProfileRemovalRequestsRepository,
  IJobPostingsRepository,
  IJobPreferencesRepository,
  IJobRunsRepository,
  IJobRunEventsRepository,
  ISubmitIntentsRepository,
  IEvidenceRepository,
  IClaimVerificationsRepository,
  IUserLlmConfigsRepository,
  IExtensionAuthCodesRepository,
  ICronHeartbeatRepository,
  ColumnRequirement,
  IApiTokensRepository,
} from '@jobagent/storage';
import type { Principal } from '@jobagent/shared';
import type { DemoConfig } from '../demo-config.js';
import type { AuthConfig } from '../auth-config.js';
import type { AuthProvider } from '../auth-provider.js';
import type { ResumePolishProvider } from '@jobagent/resume-core';
import type { CatalogCache, CoverLetterProvider } from '@jobagent/llm';
import type { ClaimOneResult } from '@jobagent/worker';
import type { MaintenanceTask } from '../cron-jobs.js';
import type { AgentConfig } from '../agent-config.js';

export interface ApiRepos {
  jobs: IAnalysisJobsRepository;
  profiles: IProfilesRepository;
  jobPostings: IJobPostingsRepository;
  evidence: IEvidenceRepository;
  demoSessions: IDemoSessionsRepository;
  applications: IApplicationsRepository;
  interviews: IInterviewsRepository;
  accounts: IAccountsRepository;
  authSessions: IAuthSessionsRepository;
  /** 画像移除申请单（审计 S3，按主体撤回的公开申请通道） */
  profileRemovalRequests: IProfileRemovalRequestsRepository;
  /** 求职偏好集（迁移 018，求职 Agent 阶段 1） */
  jobPreferences: IJobPreferencesRepository;
  /** 求职任务状态机实例（迁移 019） */
  jobRuns: IJobRunsRepository;
  /** 求职任务迁移审计日志（迁移 020，可回放） */
  jobRunEvents: IJobRunEventsRepository;
  /** 待投票据 / 人机闸票据（迁移 021） */
  submitIntents: ISubmitIntentsRepository;
  /** 内置模型目录（LLM 供给 P0，迁移 024） */
  llmCatalog: ILlmCatalogRepository;
  /** BYOK 模型配置（LLM 供给 P0，迁移 025） */
  userLlmConfigs: IUserLlmConfigsRepository;
  /** 一次性授权码（扩展登录态，迁移 026） */
  extensionAuthCodes: IExtensionAuthCodesRepository;
  /** 扩展长期 Bearer 凭证（扩展登录态，迁移 027） */
  apiTokens: IApiTokensRepository;
  /** 逐条声明核验结论（决策 #23，迁移 029） */
  claimVerifications: IClaimVerificationsRepository;
  /** cron 消费通道存活信号（迁移 031；API cron 端点写、/health?deep=1 读） */
  cronHeartbeat: ICronHeartbeatRepository;
  /** 深健康检查（SELECT 1 往返）；由持久化层提供，/health?deep=1 使用 */
  ping: () => Promise<void>;
  /** 迁移漂移守卫（deferred「迁移漂移守卫」）：核对实际 schema 关键列，返回缺失列表 */
  verifyRequiredColumns: (requirements: ColumnRequirement[]) => Promise<string[]>;
}

export interface ApiDeps {
  /** 注入仓储（测试用内存库；生产默认 createStorage） */
  repos?: ApiRepos;
  /** 注入"现在"（测试确定性） */
  now?: () => string;
  /** 注入演示配置（测试用；默认从环境变量加载） */
  demoConfig?: DemoConfig;
  /** 注入账号/OAuth 配置（测试用；默认从环境变量加载） */
  authConfig?: AuthConfig;
  /**
   * GitHub OAuth provider。
   * 不传（undefined）= 按 GITHUB_OAUTH_* env 自动构造（未配置则为 null，登录路由 501）；
   * 显式传 null = 强制禁用；测试注入 FakeAuthProvider 走完整登录链路、不打网络。
   */
  githubAuthProvider?: AuthProvider | null;
  /**
   * Gitee OAuth provider。
   * 不传（undefined）= 按 GITEE_OAUTH_* env 自动构造（未配置则为 null，登录路由 501）；
   * 显式传 null = 强制禁用；测试注入 FakeAuthProvider(platform='gitee') 走完整登录链路、不打网络。
   */
  giteeAuthProvider?: AuthProvider | null;
  /**
   * 简历 LLM 润色 provider（设计 §7/§10 #4）。
   * 不传（undefined）= 按服务端 LLM_* 环境变量自动构造（无 LLM_API_KEY 则为 null，默认关闭走规则版）；
   * 显式传 null = 强制关闭；测试注入 FakeLlmClient 包装的 provider。
   */
  resumePolish?: ResumePolishProvider | null;
  /**
   * 求职信 LLM provider（A 档，2026-10-03）。
   * 不传（undefined）= 按服务端 LLM_* 环境变量自动构造（无 LLM_API_KEY 则为 null，
   * 端点如实返回 LLM_NOT_CONFIGURED，不伪造求职信）；显式传 null = 强制关闭。
   */
  coverLetter?: CoverLetterProvider | null;
  /**
   * 单任务处理（serverless cron）。不传 = 调 @jobagent/worker 的 claimAndProcessOne
   * （读 GITHUB_TOKEN/GITEE_TOKEN）；测试注入 fake，避免打真实采集。
   */
  processJobOnce?: () => Promise<ClaimOneResult>;
  /**
   * 数据清理（serverless cron）。不传 = cron-jobs.runMaintenance（默认保留窗口）；
   * 测试注入 fake。
   */
  runMaintenance?: (task: MaintenanceTask, nowIso: string) => Promise<unknown>;
  /**
   * 求职 Agent 运行配置（阶段 1）。不传 = 按 AGENT_* env 加载（缺失则用内置默认）。
   */
  agentConfig?: AgentConfig;
  /**
   * 内置模型目录缓存（LLM 供给 P0）。不传 = 创建空缓存并尝试从仓储预载；
   * 测试注入固定缓存避免读库。
   */
  llmCatalogCache?: CatalogCache;
  /**
   * BYOK 密钥加密钥（LLM_ENC_KEY）。不传 = 读环境变量；显式传 null = 强制禁用
   * BYOK 保存（503 ENCRYPTION_NOT_CONFIGURED）。
   */
  llmEncKey?: string | null;
}

/** Hono 应用环境变量类型（principal 由全局中间件注入）。 */
export interface HonoEnv {
  Variables: { principal: Principal };
}
