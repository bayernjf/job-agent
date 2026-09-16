/**
 * @jobagent/llm：LLM 端口、假客户端与受约束简历润色 adapter。
 *
 * 当前不接任何真实厂商（待简历设计 §10 待拍板 #4：厂商/单价/预算）。
 * 真实接入新增 createXxxClient() 并只从服务端环境变量读凭证；测试一律用 FakeLlmClient。
 */
export const llmPortVersion = '0.1' as const;

export type { LlmClient, LlmChatMessage, LlmJsonRequest } from './port.js';
export { LlmResponseError } from './port.js';
export { FakeLlmClient } from './fake-client.js';
export { LlmResumePolishProvider, RESUME_POLISH_PROMPT_VERSION } from './resume-polish.js';
