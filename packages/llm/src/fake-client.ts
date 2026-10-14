import type { LlmClient, LlmJsonRequest, LlmTokenUsage } from './port.js';
import { LlmResponseError } from './port.js';

/** 测试/本地用假客户端：按注入的 responder 产出对象，记录全部请求，绝不发网络请求。 */
export class FakeLlmClient implements LlmClient {
  readonly provider = 'fake';
  /** 按调用顺序留存的请求快照（断言 prompt 与温度用）。 */
  readonly calls: LlmJsonRequest[] = [];

  /**
   * @param responder 收到请求后返回要作为 JSON 的对象；抛错则透传为 LlmResponseError；
   *                  也可返回字符串模拟模型吐非法 JSON（用于测解析失败）。
   * @param usage 可选的可控 token 用量（固定值或按请求计算），成功路径经 onUsage 回调
   *              透出；未配置时回 `{promptTokens: null, completionTokens: null}`——
   *              与真实客户端「成功必调一次、缺失如实 null」契约保持一致。
   */
  constructor(
    private readonly responder: (request: LlmJsonRequest, callIndex: number) => unknown | Promise<unknown>,
    readonly model = 'fake-model-1',
    private readonly usage?: LlmTokenUsage | ((request: LlmJsonRequest, callIndex: number) => LlmTokenUsage),
  ) {}

  async generateJson<T = unknown>(request: LlmJsonRequest): Promise<T> {
    this.calls.push(request);
    const callIndex = this.calls.length - 1;
    const raw = await this.responder(request, callIndex);
    if (typeof raw === 'string') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      } catch (err) {
        throw new LlmResponseError('fake client received non-JSON output', err);
      }
      this.reportUsage(request, callIndex);
      return parsed as T;
    }
    if (typeof raw !== 'object' || raw === null) {
      throw new LlmResponseError('fake client responder must return an object');
    }
    this.reportUsage(request, callIndex);
    return raw as T;
  }

  private reportUsage(request: LlmJsonRequest, callIndex: number): void {
    const usage =
      typeof this.usage === 'function'
        ? this.usage(request, callIndex)
        : (this.usage ?? { promptTokens: null, completionTokens: null });
    request.onUsage?.(usage);
  }
}
