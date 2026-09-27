/**
 * 受限并发映射：按给定并发上限执行异步 fn，保持输入顺序的结果数组。
 * 单条失败不影响其他条目（由调用方决定如何处理 undefined / 异常）。
 *
 * 用途：ATS 类源的 board 列表较长（Greenhouse 45 家、Lever 9 家），串行拉取在
 * 部分网络下会因单请求超时（默认 15s）而线性放大总时长（45×15s 远超 20min
 * workflow 上限）；并发拉取把最坏时长压缩到 批数 × 超时。
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
