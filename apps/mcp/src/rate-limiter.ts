/**
 * 固定窗口限流（决策 #19 §5）：按 "key + IP 哈希" 分桶，每窗口最多 N 次。
 *
 * 这是本提案新增暴露面的必要防线：lookup_profile_by_subject + get_profile 组合可按
 * login 枚举画像。stdio 本地场景通常没有源 IP（ipHash=null），则退化为按 key 单桶。
 * 不落原始 IP、不落请求内容，只记时间戳。
 */
export interface FixedWindowOptions {
  windowMs: number;
  maxRequests: number;
  now?: () => number;
}

interface Bucket {
  windowStart: number;
  timestamps: number[];
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly now: () => number;

  constructor(opts: FixedWindowOptions) {
    this.windowMs = opts.windowMs;
    this.maxRequests = opts.maxRequests;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * 尝试占一个额度。
   * @returns allowed=true 放行；false 表示该桶本窗口已超限。
   */
  tryConsume(bucketKey: string): { allowed: boolean; remaining: number; resetMs: number } {
    const at = this.now();
    const existing = this.buckets.get(bucketKey);
    if (!existing || at - existing.windowStart >= this.windowMs) {
      const fresh: Bucket = { windowStart: at, timestamps: [at] };
      this.buckets.set(bucketKey, fresh);
      return { allowed: true, remaining: this.maxRequests - 1, resetMs: this.windowMs };
    }
    // 清理窗口内时间戳（固定窗口内保留，过期由整窗切换处理）
    if (existing.timestamps.length >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetMs: this.windowMs - (at - existing.windowStart),
      };
    }
    existing.timestamps.push(at);
    return {
      allowed: true,
      remaining: this.maxRequests - existing.timestamps.length,
      resetMs: this.windowMs - (at - existing.windowStart),
    };
  }

  /** 测试/运维用：当前桶状态。 */
  bucketState(bucketKey: string): { count: number; windowStart: number } | undefined {
    const b = this.buckets.get(bucketKey);
    return b ? { count: b.timestamps.length, windowStart: b.windowStart } : undefined;
  }

  /** 清空全部计数（测试用）。 */
  reset(): void {
    this.buckets.clear();
  }
}
