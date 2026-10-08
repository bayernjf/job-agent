/**
 * CSV 序列化工具（B1-c 候选人清单导出，2026-10-08）。
 * 只做两件事：字段转义 + 行/列拼装。RFC 4180 子集：
 *   字段含 逗号/双引号/换行 时用双引号包裹，内部双引号翻倍；
 *   行以 CRLF 结束；null/undefined 输出空字段。
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCsvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
