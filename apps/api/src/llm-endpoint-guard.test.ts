import { describe, expect, it } from 'vitest';
import { checkLlmEndpoint, classifyLlmEndpointAddress } from './llm-endpoint-guard.js';

/**
 * 决策 #26：只封云元数据 + link-local，保留 localhost 与私网（自建网关用例）。
 * 这些用例是纯函数、零网络。
 */
describe('checkLlmEndpoint', () => {
  it('blocks cloud metadata addresses', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://100.100.100.200/latest/meta-data',
      'http://[fd00:ec2::254]/v1',
      'http://metadata.google.internal/v1',
      'http://metadata.goog/v1',
      'http://instance-data/latest',
      'http://metadata.tencentyun.com/v1',
    ]) {
      expect(checkLlmEndpoint(url).ok, url).toBe(false);
    }
  });

  it('blocks link-local addresses (IPv4 and IPv6)', () => {
    for (const url of [
      'http://169.254.1.1/v1',
      'http://[fe80::1]/v1',
      'http://[febf::abcd]/v1',
      // IPv4-mapped IPv6 must not bypass the check
      'http://[::ffff:169.254.169.254]/v1',
      'http://[::ffff:a9fe:a9fe]/v1',
    ]) {
      expect(checkLlmEndpoint(url).ok, url).toBe(false);
    }
  });

  it('keeps loopback and private networks for self-hosted gateways', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://[::1]:8080/v1',
      'http://10.0.0.5/v1',
      'http://172.16.4.2/v1',
      'http://192.168.1.20/v1',
      'https://api.openai.com/v1',
    ]) {
      expect(checkLlmEndpoint(url).ok, url).toBe(true);
    }
  });

  it('rejects non-http(s) schemes and non-URL input', () => {
    expect(checkLlmEndpoint('ftp://example.com/v1')).toEqual({
      ok: false,
      reason: 'unsupported_scheme',
    });
    expect(checkLlmEndpoint('not a url')).toEqual({ ok: false, reason: 'unsupported_scheme' });
  });
});

describe('classifyLlmEndpointAddress', () => {
  it('classifies metadata before link-local and ignores allowed ranges', () => {
    expect(classifyLlmEndpointAddress('169.254.169.254')).toBe('metadata');
    expect(classifyLlmEndpointAddress('169.254.9.9')).toBe('link_local');
    expect(classifyLlmEndpointAddress('fe80::1')).toBe('link_local');
    expect(classifyLlmEndpointAddress('127.0.0.1')).toBeNull();
    expect(classifyLlmEndpointAddress('10.1.2.3')).toBeNull();
    expect(classifyLlmEndpointAddress('203.0.113.9')).toBeNull();
  });
});
