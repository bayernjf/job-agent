/**
 * @jobagent/llm：LLM 端口、假客户端、OpenAI 兼容客户端与受约束简历润色 adapter。
 *
 * 默认不接真实厂商：未配置服务端 LLM_API_KEY 时 createResumePolishProviderFromEnv
 * 返回 null，调用方走规则版（零费用、零数据外发）。配置任意 OpenAI 兼容端点
 * （LLM_BASE_URL/LLM_API_KEY/LLM_MODEL）后启用，凭证只从服务端环境变量读取。
 * 测试一律用 FakeLlmClient 或注入假 fetch，不发真实请求。
 */
export const llmPortVersion = '0.2' as const;

export type { LlmClient, LlmChatMessage, LlmJsonRequest } from './port.js';
export { LlmResponseError } from './port.js';
export { FakeLlmClient } from './fake-client.js';
export { LlmResumePolishProvider, RESUME_POLISH_PROMPT_VERSION } from './resume-polish.js';
export {
  OpenAICompatibleClient,
  createResumePolishProviderFromEnv,
  providerFromBaseUrl,
  parseJsonObject,
} from './openai-compatible-client.js';
export type {
  OpenAICompatibleConfig,
  LlmEnv,
  LlmFetch,
  LlmFetchInit,
  LlmFetchResponse,
  CreateProviderOptions,
} from './openai-compatible-client.js';
