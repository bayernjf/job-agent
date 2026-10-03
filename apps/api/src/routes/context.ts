/**
 * Router 共享依赖（Q1 单文件拆分）。
 * createApp 组装出一个 RouteDeps，各域 register 函数从中解构所需名字，
 * handler 逻辑与原 index.ts 完全一致（仅把闭包变量改为从 d 取）。
 */
import type { Context } from 'hono';
import type { AgentRepos } from '../agent-runner.js';
import type { AgentConfig } from '../agent-config.js';
import type { AuthProvider } from '../auth-provider.js';
import type { ResumePolishProvider } from '@jobagent/resume-core';
import type { CoverLetterProvider } from '@jobagent/llm';
import type { AuthConfig } from '../auth-config.js';
import type { DemoConfig } from '../demo-config.js';
import type { ApiDeps, ApiRepos } from './types.js';

export interface RouteDeps {
  /** 全部仓储（生产 createStorage / 测试内存库） */
  repos: ApiRepos;
  /** 可注入的"现在" */
  now: () => string;
  /** 演示模式配置 */
  cfg: DemoConfig;
  /** 账号 / OAuth 配置 */
  authCfg: AuthConfig;
  githubProvider: AuthProvider | null;
  giteeProvider: AuthProvider | null;
  /** 简历 LLM 润色（未配置为 null，规则版兜底） */
  polishProvider: ResumePolishProvider | null;
  /** 求职信 LLM 生成（A 档；未配置为 null，端点如实返回 LLM_NOT_CONFIGURED） */
  coverLetterProvider: CoverLetterProvider | null;
  /** OAuth state 签名密钥（AUTH_STATE_SECRET 或进程随机） */
  stateSecret: string;
  agentConfig: AgentConfig;
  agentRepos: AgentRepos;
  /** 加盐 IP 哈希（无可信 IP 返回 null） */
  ipHashOf: (c: Context) => string | null;
  /** cron 端点鉴权（CRON_SECRET 常量时间比较 / x-vercel-cron 回退） */
  cronAuthorized: (c: Context) => boolean;
  /** 原始注入依赖（cron override：processJobOnce / runMaintenance） */
  deps: ApiDeps;
}
