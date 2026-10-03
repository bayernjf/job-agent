import { describe, expect, it } from 'vitest';
import {
  ALLOWED_EXTERNAL_ORIGINS,
  isAllowedExternalOrigin,
  isAllowedRelayHost,
  resolveSenderOrigin,
} from './external-origins';

describe('external-origins（S7/S8 可信源白名单）', () => {
  it('S7：外部消息只接受白名单 origin（报告页域 + 本地 4321 报告页源）', () => {
    expect(isAllowedExternalOrigin({ origin: 'https://app.job-agent.bayjf.com' })).toBe(true);
    expect(isAllowedExternalOrigin({ origin: 'http://localhost:4321' })).toBe(true);
    expect(isAllowedExternalOrigin({ origin: 'http://127.0.0.1:4321' })).toBe(true);
    expect(isAllowedExternalOrigin({ origin: 'https://evil.example.com' })).toBe(false);
    // 同源域名不同端口不算白名单（manifest 只授权 4321）
    expect(isAllowedExternalOrigin({ origin: 'http://localhost:9999' })).toBe(false);
    // 子域不算（externally_connectable 不匹配通配子域）
    expect(isAllowedExternalOrigin({ origin: 'https://sub.app.job-agent.bayjf.com' })).toBe(false);
  });

  it('S7：sender 无 origin 时回退 url 解析；两者皆缺或不可解析则拒绝（fail closed）', () => {
    expect(isAllowedExternalOrigin({ url: 'https://app.job-agent.bayjf.com/zh/report/x' })).toBe(true);
    expect(isAllowedExternalOrigin({})).toBe(false);
    expect(isAllowedExternalOrigin(null)).toBe(false);
    expect(isAllowedExternalOrigin(undefined)).toBe(false);
    expect(resolveSenderOrigin({ url: 'not-a-url' })).toBeNull();
  });

  it('S8：relay host 白名单 = localhost / 127.0.0.1 / 生产域', () => {
    expect(isAllowedRelayHost('localhost')).toBe(true);
    expect(isAllowedRelayHost('127.0.0.1')).toBe(true);
    expect(isAllowedRelayHost('app.job-agent.bayjf.com')).toBe(true);
    expect(isAllowedRelayHost('evil.example.com')).toBe(false);
    expect(isAllowedRelayHost('app.job-agent.bayjf.com.evil.io')).toBe(false);
  });

  it('S7：白名单与 manifest externally_connectable 同口径（localhost:4321 报告页源）', () => {
    expect(ALLOWED_EXTERNAL_ORIGINS.has('http://localhost:4321')).toBe(true);
    expect(ALLOWED_EXTERNAL_ORIGINS.has('http://127.0.0.1:4321')).toBe(true);
    expect(ALLOWED_EXTERNAL_ORIGINS.has('https://app.job-agent.bayjf.com')).toBe(true);
  });
});
