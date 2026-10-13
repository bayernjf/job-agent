/**
 * LLM 客户端端口（provider-agnostic）。
 *
 * 内核（analyzer-core / resume-core 的 polishResume 安全层）不直接依赖任何厂商 SDK，
 * 只依赖此接口；真实厂商 adapter（OpenAI / AnthropIC / 国内厂商等）在**用户决策
 * 厂商、单价与预算后**（简历设计 §10 待决策 #4）再新增，当前仓库不接真实密钥、不发外网请求。
 *
 * 接入真实厂商时新增 `createXxxClient(env)`：
 *  - 凭证只从服务端环境变量读取：`LLM_API_KEY`（必填）、`LLM_BASE_URL`、`LLM_MODEL`，
 *    绝不进 Git / 构建产物 / 前端；同步登记到 `.env.example`；
 *  - 用厂商的 JSON / structured-output 模式，拿到响应后先 JSON.parse 再交调用方做 Zod 校验；
 *  - 解析失败 / HTTP 非 2xx / 超时统一抛 {@link LlmResponseError}，由调用方决定回退。
 * 测试与默认路径一律用 {@link FakeLlmClient}，保证确定性（AGENTS：测试不调真实 LLM）。
 */

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 一次成功调用的 token 用量（决策 #25 ④ 成本回采，2026-10-14）。
 * 字段可空：部分 OpenAI 兼容网关不回 usage、或只回其中一个——缺失如实给 null，绝不编数。
 */
export interface LlmTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * 用量观察回调：每请求级别透出 token 用量（per-call 通道，client 上不挂可变状态，
 * 避免跨请求单例并发串号）。契约：**成功路径恰好回调一次；失败路径（HTTP/超时/解析错）
 * 绝不回调**——失败的调用 token 不可得，计量侧据此只记录真实完成的可计费调用。
 */
export type LlmUsageObserver = (usage: LlmTokenUsage) => void;

export interface LlmJsonRequest {
  messages: LlmChatMessage[];
  /** 低温度默认更稳；润色等保守任务建议 0.2–0.4。 */
  temperature?: number;
  /** 调用方可选的请求标识（日志/去重），不参与签名。 */
  requestId?: string;
  /** 可选的用量观察回调（计量埋点用）；不设置则不观察，不影响主调用。 */
  onUsage?: LlmUsageObserver;
}

export interface LlmClient {
  /** 提供方标识，写入简历 provenance.polish.provider（如 'openai' / 'fake'）。 */
  readonly provider: string;
  /** 模型 id，写入 provenance.polish.model。 */
  readonly model: string;
  /**
   * 生成并返回一个 JSON 对象。实现必须：开启 JSON/结构化输出模式、解析为对象；
   * 无法得到合法 JSON 对象时 reject {@link LlmResponseError}（不返回字符串/部分对象）。
   */
  generateJson<T = unknown>(request: LlmJsonRequest): Promise<T>;
}

/** 失败性质：让日志与降级判断不必回头解析 message 文本。 */
export type LlmFailureKind = 'timeout' | 'http' | 'network' | 'parse';

export interface LlmFailureDetail {
  kind: LlmFailureKind;
  /** 上游 HTTP 状态码（kind='http'） */
  status?: number;
  /** 本次请求的超时预算（kind='timeout'） */
  timeoutMs?: number;
}

/** LLM 响应不可用：网络/HTTP 错误、超时、或输出不是合法 JSON 对象。 */
export class LlmResponseError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    /** 结构化失败信息。服务端日志靠它区分"上游 401"与"60s 超时"，不再猜。 */
    readonly detail?: LlmFailureDetail,
  ) {
    super(message);
    this.name = 'LlmResponseError';
  }
}
