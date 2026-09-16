/**
 * LLM 客户端端口（provider-agnostic）。
 *
 * 内核（analyzer-core / resume-core 的 polishResume 安全层）不直接依赖任何厂商 SDK，
 * 只依赖此接口；真实厂商 adapter（OpenAI / AnthropIC / 国内厂商等）在**用户拍板
 * 厂商、单价与预算后**（简历设计 §10 待拍板 #4）再新增，当前仓库不接真实密钥、不发外网请求。
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

export interface LlmJsonRequest {
  messages: LlmChatMessage[];
  /** 低温度默认更稳；润色等保守任务建议 0.2–0.4。 */
  temperature?: number;
  /** 调用方可选的请求标识（日志/去重），不参与签名。 */
  requestId?: string;
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

/** LLM 响应不可用：网络/HTTP 错误、超时、或输出不是合法 JSON 对象。 */
export class LlmResponseError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmResponseError';
  }
}
