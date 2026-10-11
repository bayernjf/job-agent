import type { L3MissingKey, L3SemanticInput } from '@jobagent/shared';

export interface SemanticSourceOptions {
  token: string;
  /** 每画像扫描仓库数（默认 5，最近活跃） */
  reposN?: number;
  /** REST 预算（默认 60 次/画像） */
  budget?: { restCalls: number };
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** 自定义 fetch（测试注入用；默认 Node 全局 fetch） */
  fetch?: typeof fetch;
}

export interface L3CollectedData {
  input: L3SemanticInput;
  meta: {
    platform: 'github';
    restCalls: number;
    reposScanned: number;
  };
}

export class SemanticSourceError extends Error {
  constructor(
    readonly code: 'not_found' | 'api_error' | 'budget_exhausted',
    message: string,
  ) {
    super(message);
    this.name = 'SemanticSourceError';
  }
}

export type { L3MissingKey };
