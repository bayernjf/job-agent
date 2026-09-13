/**
 * 岗位发布时间归一化：各源格式不一，统一输出带时区的 ISO 字符串（满足 z.datetime()）。
 *
 * - RemoteOK epoch（秒）、Lever createdAt（毫秒）；
 * - Remotive publication_date 形如 "2026-09-11T06:49:00"（无时区，按 UTC 补 Z）；
 * - 缺失/无法解析时回退到 fetchedAt，并可由调用方打 'date:unknown' 标记。
 */

const EPOCH_MS_THRESHOLD = 1e12; // 小于该值视为「秒」

export function epochToIso(epoch: unknown): string | null {
  const n = typeof epoch === 'number' ? epoch : Number(epoch);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < EPOCH_MS_THRESHOLD ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 字符串时间：无时区后缀的按 UTC 处理；非法返回 null。 */
export function textToIso(text: unknown): string | null {
  if (text == null) return null;
  let s = String(text).trim();
  if (s.length === 0) return null;
  // 形如 2026-09-11T06:49:00（无 Z / 偏移）→ 按 UTC
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    s = s.replace(' ', 'T').replace(/(\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/, '$1Z');
    if (!s.endsWith('Z')) s += 'Z';
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 统一入口：优先数值 epoch，其次文本，最后回退 fallbackIso。 */
export function toPostedIso(value: unknown, fallbackIso: string): string {
  if (typeof value === 'number') return epochToIso(value) ?? fallbackIso;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return epochToIso(Number(value.trim())) ?? fallbackIso;
  }
  return textToIso(value) ?? fallbackIso;
}
