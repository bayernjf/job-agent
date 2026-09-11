import { retry, type RetryOptions } from '@octokit/plugin-retry';
import { throttling, type ThrottlingOptions } from '@octokit/plugin-throttling';
import { Octokit } from 'octokit';
import type { ProfileBudget } from './types.js';

const RetryingOctokit = Octokit.plugin(throttling, retry);

export const DEFAULT_BUDGET: ProfileBudget = {
  graphqlPoints: 1500,
  restCalls: 120,
};

export interface OctokitFactoryOptions {
  token: string;
  budget?: Partial<ProfileBudget>;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** 自定义 fetch（测试注入用；默认 Node 全局 fetch） */
  fetch?: typeof fetch;
  /** 关闭限频器（测试/fake 场景用；生产保持 true） */
  throttleEnabled?: boolean;
}

/** 限频自动退避（次级限频读 Retry-After，有上限重试；返回 true 表示等待后重试） */
const throttle: ThrottlingOptions = {
  onRateLimit: (retryAfter, _requestOptions, octokit, retryCount) => {
    octokit.log.warn(`request quota exhausted, retrying in ${retryAfter}s (attempt ${retryCount + 1})`);
    return retryCount < 2;
  },
  onSecondaryRateLimit: (retryAfter, _requestOptions, octokit, retryCount) => {
    octokit.log.warn(`secondary rate limit hit, retrying in ${retryAfter}s (attempt ${retryCount + 1})`);
    return retryCount < 3;
  },
};

const retryOptions: RetryOptions = {
  doNotRetry: [400, 401, 403, 404, 422],
  retries: 2,
};

/** 创建带限频退避与重试的 Octokit 实例（凭证仅在服务端使用） */
export function createOctokit(options: OctokitFactoryOptions): Octokit {
  return new RetryingOctokit({
    auth: options.token,
    userAgent: 'job-agent/0.1.0',
    throttle: options.throttleEnabled === false ? { enabled: false } : throttle,
    retry: retryOptions,
    request: options.fetch ? { fetch: options.fetch } : undefined,
  });
}
