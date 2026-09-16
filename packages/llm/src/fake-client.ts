import type { LlmClient, LlmJsonRequest } from './port.js';
import { LlmResponseError } from './port.js';

/** 测试/本地用假客户端：按注入的 responder 产出对象，记录全部请求，绝不发网络请求。 */
export class FakeLlmClient implements LlmClient {
  readonly provider = 'fake';
  /** 按调用顺序留存的请求快照（断言 prompt 与温度用）。 */
  readonly calls: LlmJsonRequest[] = [];

  /**
   * @param responder 收到请求后返回要作为 JSON 的对象；抛错则透传为 LlmResponseError；
   *                  也可返回字符串模拟模型吐非法 JSON（用于测解析失败）。
   */
  constructor(
    private readonly responder: (request: LlmJsonRequest, callIndex: number) => unknown | Promise<unknown>,
    readonly model = 'fake-model-1',
  ) {}

  async generateJson<T = unknown>(request: LlmJsonRequest): Promise<T> {
    this.calls.push(request);
    const raw = await this.responder(request, this.calls.length - 1);
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        return parsed as T;
      } catch (err) {
        throw new LlmResponseError('fake client received non-JSON output', err);
      }
    }
    if (typeof raw !== 'object' || raw === null) {
      throw new LlmResponseError('fake client responder must return an object');
    }
    return raw as T;
  }
}
