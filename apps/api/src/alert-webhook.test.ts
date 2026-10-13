/**
 * alert-webhook 单测（2026-10-14）：平台报文格式自动识别 + fail-open 语义。
 * 全部注入 fetchImpl，零真实网络。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildAlertWebhookBody,
  detectAlertWebhookPlatform,
  sendAlertWebhook,
} from './alert-webhook.js';

describe('detectAlertWebhookPlatform', () => {
  it('recognizes the WeCom robot host', () => {
    expect(detectAlertWebhookPlatform('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc')).toBe(
      'wecom',
    );
  });

  it('recognizes Feishu and Lark bot hosts', () => {
    expect(detectAlertWebhookPlatform('https://open.feishu.cn/open-apis/bot/v2/hook/xyz')).toBe('feishu');
    expect(detectAlertWebhookPlatform('https://open.larksuite.com/open-apis/bot/v2/hook/xyz')).toBe('feishu');
  });

  it('falls back to the Slack-compatible shape for unknown gateways', () => {
    expect(detectAlertWebhookPlatform('https://hooks.slack.com/services/T/B/XXX')).toBe('slack');
    expect(detectAlertWebhookPlatform('https://example.com/alert')).toBe('slack');
  });

  it('falls back to slack for a malformed URL instead of throwing', () => {
    expect(detectAlertWebhookPlatform('not-a-url')).toBe('slack');
  });
});

describe('buildAlertWebhookBody', () => {
  it('builds the WeCom markdown payload', () => {
    const body = JSON.parse(
      buildAlertWebhookBody('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc', 'hello'),
    ) as { msgtype: string; markdown: { content: string } };
    expect(body.msgtype).toBe('markdown');
    expect(body.markdown.content).toBe('hello');
  });

  it('builds the Feishu text payload', () => {
    const body = JSON.parse(
      buildAlertWebhookBody('https://open.feishu.cn/open-apis/bot/v2/hook/xyz', 'hello'),
    ) as { msg_type: string; content: { text: string } };
    expect(body.msg_type).toBe('text');
    expect(body.content.text).toBe('hello');
  });

  it('builds the Slack-compatible text payload', () => {
    const body = JSON.parse(buildAlertWebhookBody('https://hooks.slack.com/services/T/B/XXX', 'hello')) as {
      text: string;
    };
    expect(body.text).toBe('hello');
  });
});

describe('sendAlertWebhook', () => {
  it('POSTs the platform-shaped body as JSON and reports ok', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await sendAlertWebhook(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc',
      'stale',
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ msgtype: 'markdown', markdown: { content: 'stale' } });
  });

  it('reports a non-2xx platform answer as not ok (no throw)', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad webhook', { status: 400 }));
    const result = await sendAlertWebhook('https://example.com/alert', 'x', fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it('swallows network errors instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    const result = await sendAlertWebhook('https://example.com/alert', 'x', fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOTFOUND');
  });

  it('swallows a malformed webhook URL instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await sendAlertWebhook('not-a-url', 'x', fetchImpl as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-https webhook URL instead of leaking the token in clear text', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const result = await sendAlertWebhook(
      'http://example.com/alert?key=secret',
      'x',
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('http:');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
