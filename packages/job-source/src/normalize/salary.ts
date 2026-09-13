/**
 * 薪资归一化。
 *
 * - RemoteOK 给数值 salary_min/salary_max，0 表示未提供 → null；
 * - Remotive 只给字符串（"$10K-$20K"、"OTE $25k - $35k"、"$120,000 - $150,000"），
 *   需自行解析；K/k=×1000，M/m=×1e6；
 * - 非 USD（€/£）MVP 不维护汇率表、不猜测换算：数值置 null，仅保留 currency；
 * - 时薪 ×2080、月薪 ×12 年化（仅在文本明确出现 /hr、/month 时）。
 */

export interface SalaryRange {
  min: number | null;
  max: number | null;
  currency: string | null;
}

const NULL_RANGE: SalaryRange = { min: null, max: null, currency: null };

function detectCurrency(text: string): string | null {
  if (/\$|USD/i.test(text)) return 'USD';
  if (/€|EUR/i.test(text)) return 'EUR';
  if (/£|GBP/i.test(text)) return 'GBP';
  return null;
}

function scaleNumber(raw: string, suffix: string | undefined, per: 'year' | 'hour' | 'month'): number {
  let n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) return NaN;
  const s = suffix?.toLowerCase();
  if (s === 'k') n *= 1000;
  else if (s === 'm') n *= 1_000_000;
  if (per === 'hour') n *= 2080;
  else if (per === 'month') n *= 12;
  return Math.round(n);
}

function detectPeriod(text: string): 'year' | 'hour' | 'month' {
  if (/\/?(?:hr|hour)|per\s*hour/i.test(text)) return 'hour';
  if (/\/?(?:mo|month)|per\s*month/i.test(text)) return 'month';
  return 'year';
}

/** 从自由文本薪资字符串解析区间；解析不到返回全 null。 */
export function parseSalaryText(input: unknown): SalaryRange {
  if (input == null) return { ...NULL_RANGE };
  const text = String(input).trim();
  if (text.length === 0) return { ...NULL_RANGE };

  const currency = detectCurrency(text);
  const per = detectPeriod(text);
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?/g;
  const values: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const v = scaleNumber(match[1]!, match[2], per);
    if (Number.isFinite(v) && v > 0) values.push(v);
  }
  if (values.length === 0) return { min: null, max: null, currency };

  values.sort((a, b) => a - b);
  const min = values[0]!;
  const max = values.length > 1 ? values[values.length - 1]! : min;

  // 非 USD 不猜汇率：不输出可能误导的数值，仅保留币种
  if (currency && currency !== 'USD') return { min: null, max: null, currency };
  return { min, max, currency };
}

/** RemoteOK 等数值型薪资：0 / 非有限值视为未提供。 */
export function nullifyZero(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}
