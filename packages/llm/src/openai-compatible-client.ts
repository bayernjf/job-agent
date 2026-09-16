/**
 * OpenAI 兼容 Chat Completions 客户端（provider-agnostic）。
 *
 * 一个实现覆盖所有暴露 `/chat/completions` + `response_format: json_object` 的
 * OpenAI 兼容端点：OpenAI、DeepSeek、通义千问兼容模式、智谱/Moonshot 兼容网关、
 * 本地 vLLM/Ollama（OpenAI 兼容层）等。具体厂商与单价不写死在代码里，由服务端
 * 环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_PROVIDER 决定（见工厂）。
 *
 * 安全：API key 只放进 Authorization 头、绝不进错误消息 / 日志 / Git / 构建产物 / 前端。
 * 测试一律注入假 fetch（{@link LlmFetch}），不发真实网络请求。
 */
import type { ResumePolishProvider } from '@jobagent/resume-core';
import type { LlmClient, LlmJsonRequest } from './port.js';
import { LlmResponseError } from './port.js';
import { LlmResumePolishProvider } from './resume-polish.js';

/** 可注入的最小响应形状（不依赖 DOM lib 的 Response 类型）。 */
export interface LlmFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface LlmFetchInit {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** 可注入的最小 fetch 形状；生产默认包全局 fetch，测试给内存假实现。 */
export type LlmFetch = (url: string, init: LlmFetchInit) => Promise<LlmFetchResponse>;

const defaultFetch: LlmFetch = (url, init) =>
  globalThis.fetch(url, init) as Promise<LlmFetchResponse>;

export interface OpenAICompatibleConfig {
  /** 含版本前缀的根地址，如 https://api.openai.com/v1 或 http://localhost:11434/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 显式 provider 标识（写入 provenance）；缺省按 baseUrl 主机推断 */
  provider?: string;
  /** 请求超时毫秒，默认 30000 */
  timeoutMs?: number;
  /** 额外请求头（如自建网关的兼容头），Authorization 不可被覆盖 */
  extraHeaders?: Record<string, string>;
  /** 注入 fetch（测试） */
  fetchImpl?: LlmFetch;
}

/** 常见 OpenAI 兼容主机 → provider 标识；未命中回退主机二级名，可用 LLM_PROVIDER 覆盖。 */
const KNOWN_PROVIDERS: Record<string, string> = {
  'api.openai.com': 'openai',
  'api.deepseek.com': 'deepseek',
  'dashscope.aliyuncs.com': 'qwen',
  'open.bigmodel.cn': 'zhipu',
  'api.moonshot.cn': 'moonshot',
};

/** 由 base URL 推断稳定的 provider 标识（仅用于 provenance 展示，可被显式 provider 覆盖）。 */
export function providerFromBaseUrl(baseUrl: string): string {
  let host = '';
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    host = baseUrl.toLowerCase();
  }
  const known = KNOWN_PROVIDERS[host];
  if (known) return known;
  const bare = host.replace(/^www\./, '');
  const parts = bare.split('.');
  if (parts.length >= 2) return parts[parts.length - 2] ?? bare;
  return bare.split(':')[0] ?? bare;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/**
 * 把模型返回的 content 解析为 JSON 对象：容忍 ```json fenced 包裹与首尾空白；
 * 非法 / 数组 / 标量一律返回 undefined（调用方据此抛 LlmResponseError）。
 */
export function parseJsonObject(content: string): unknown {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence && fence[1] !== undefined) text = fence[1].trim();
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class OpenAICompatibleClient implements LlmClient {
  readonly provider: string;
  readonly model: string;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: LlmFetch;

  constructor(config: OpenAICompatibleConfig) {
    if (!config.apiKey.trim()) throw new Error('OpenAICompatibleClient requires an apiKey');
    if (!config.model.trim()) throw new Error('OpenAICompatibleClient requires a model');
    if (!config.baseUrl.trim()) throw new Error('OpenAICompatibleClient requires a baseUrl');
    this.apiKey = config.apiKey.trim();
    this.model = config.model.trim();
    this.endpoint = `${stripTrailingSlash(config.baseUrl.trim())}/chat/completions`;
    this.provider = config.provider?.trim() || providerFromBaseUrl(config.baseUrl);
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.extraHeaders = config.extraHeaders ?? {};
    this.fetchImpl = config.fetchImpl ?? defaultFetch;
  }

  async generateJson<T = unknown>(request: LlmJsonRequest): Promise<T> {
    const messages: OpenAIChatMessage[] = request.messages.map((m) => ({ role: m.role, content: m.content }));
    const init: LlmFetchInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: request.temperature ?? 0.3,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    let res: LlmFetchResponse;
    try {
      res = await this.fetchImpl(this.endpoint, init);
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') {
        throw new LlmResponseError(`LLM request timed out after ${this.timeoutMs}ms`, err);
      }
      throw new LlmResponseError(
        `LLM request failed: ${(err as Error)?.message ?? 'network error'}`,
        err,
      );
    }

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        // 读取错误体失败时忽略，仅保留状态码
      }
      throw new LlmResponseError(
        `LLM endpoint returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`,
      );
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      throw new LlmResponseError('LLM response body is not valid JSON', err);
    }

    const content = (
      data as { choices?: Array<{ message?: { content?: unknown } }> } | null
    )?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new LlmResponseError('LLM response missing choices[0].message.content string');
    }
    const parsed = parseJsonObject(content);
    if (parsed === undefined) throw new LlmResponseError('LLM content is not a JSON object');
    return parsed as T;
  }
}

/** 服务端环境变量形状（process.env 子集）。 */
export interface LlmEnv {
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  LLM_PROVIDER?: string;
  LLM_TIMEOUT_MS?: string;
}

export interface CreateProviderOptions {
  /** 注入 fetch（测试用，保证不联网） */
  fetchImpl?: LlmFetch;
}

/**
 * 仅从**服务端**环境变量构造简历润色 provider（设计 §10 #4 的默认关闭策略）：
 *  - 未设置 LLM_API_KEY → 返回 null，调用方走规则版（零费用、零数据外发）；
 *  - 设置了 key 但缺 LLM_MODEL → 抛错（不替用户默认某个付费模型）；
 *  - LLM_BASE_URL 缺省 https://api.openai.com/v1，可指向任意 OpenAI 兼容网关。
 * 凭证绝不入 Git / 构建产物 / 前端；登记见 .env.example。
 */
export function createResumePolishProviderFromEnv(
  env: LlmEnv = process.env,
  options: CreateProviderOptions = {},
): ResumePolishProvider | null {
  const apiKey = env.LLM_API_KEY?.trim() ?? '';
  if (!apiKey) return null;

  const model = env.LLM_MODEL?.trim() ?? '';
  if (!model) {
    throw new Error(
      'LLM_API_KEY is set but LLM_MODEL is missing; set an OpenAI-compatible model id',
    );
  }

  const baseUrl = stripTrailingSlash(env.LLM_BASE_URL?.trim() || 'https://api.openai.com/v1');
  const parsedTimeout = Number(env.LLM_TIMEOUT_MS);
  const timeoutMs =
    env.LLM_TIMEOUT_MS && Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : undefined;

  const client = new OpenAICompatibleClient({
    baseUrl,
    apiKey,
    model,
    provider: env.LLM_PROVIDER?.trim() || undefined,
    timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  return new LlmResumePolishProvider(client);
}
