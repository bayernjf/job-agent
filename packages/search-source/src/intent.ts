/**
 * 意图解析（design-websearch-job-discovery §2 步骤② / §6 LLM 角色）。
 *
 * 用户自然语言指令 → 结构化 SearchConditions：
 * - 优先走 LLM（LlmClient 注入，JSON 结构化输出 + Zod 校验）；
 * - LLM 不可用 / 校验失败 / 解析抛错 → 规则回落（保证主流程不阻塞）；
 * - 落回结果的 queries 保证非空（至少一条），匹配 shared 契约。
 *
 * 纯函数 + 依赖注入，测试用 fake LLM（AGENTS：测试不调真实 LLM）。
 */
import { SearchConditionsSchema, type SearchConditions } from '@jobagent/shared';
import type { LlmClient, LlmResponseError } from '@jobagent/llm';

export interface IntentParserOptions {
  /** 可选：内置/BYOK LLM 客户端（由 API 侧从目录解析后注入；缺省走规则回落） */
  llm?: LlmClient;
  /** 调试/日志标识（透传 LLM requestId） */
  requestId?: string;
}

/** 从自然语言指令解析出结构化搜索条件（LLM 优先、规则回落）。 */
export async function parseSearchIntent(query: string, opts: IntentParserOptions = {}): Promise<SearchConditions> {
  if (opts.llm) {
    const viaLlm = await tryParseWithLlm(query, opts.llm, opts.requestId);
    if (viaLlm) return viaLlm;
  }
  return ruleFallback(query);
}

async function tryParseWithLlm(
  query: string,
  llm: LlmClient,
  requestId?: string,
): Promise<SearchConditions | undefined> {
  try {
    const raw = await llm.generateJson<unknown>({
      requestId,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            '你是求职搜岗意图解析器。把用户的中文/英文求职指令解析为结构化搜索条件。' +
            'queries 是发往搜索 API 的 1-5 条搜索词（可组合岗位关键词+地区/平台），' +
            'location 是地区关键词（无则 null），remote 表示是否要求远程，' +
            'salaryMinUsd 是年薪下限美元（无法推断则 null），keywords 是 JD 二次过滤关键词（最多 20 个）。' +
            '只输出 JSON 对象，不要任何解释。',
        },
        { role: 'user', content: query },
      ],
    });
    const parsed = SearchConditionsSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch (err) {
    // LlmResponseError（JSON 不可用）与任何异常都静默回落，不让 LLM 阻塞搜岗
    void err;
    return undefined;
  }
}

// ─── 规则回落（LLM 不可用/失败时的确定性解析）──────────────────────────────

/** 常见地区关键词表（命中即作为 location 条件；可随产品演进扩充） */
const LOCATION_HINTS: ReadonlyArray<readonly [string, string]> = [
  // 中国大陆城市
  ['深圳', '深圳'], ['北京', '北京'], ['上海', '上海'], ['广州', '广州'],
  ['杭州', '杭州'], ['成都', '成都'], ['南京', '南京'], ['武汉', '武汉'], ['苏州', '苏州'],
  // 海外常见
  ['shenzhen', 'Shenzhen'], ['beijing', 'Beijing'], ['shanghai', 'Shanghai'], ['singapore', 'Singapore'],
  ['remote', 'Remote'], ['new york', 'New York'], ['san francisco', 'San Francisco'],
  ['london', 'London'], ['berlin', 'Berlin'], ['tokyo', 'Tokyo'],
];

const REMOTE_HINTS = /远程|居家|remote|anywhere|fully\s*remote|work\s*from\s*home/i;
/** 英文年薪模式：$100k-$150k / $100,000 / 100-150k / 年薪 30万（人民币不换算，仅美元模式入列） */
const SALARY_USD_PATTERNS: ReadonlyArray<RegExp> = [
  /\$\s*(\d{2,3})\s*k/i, // $120k
  /\$\s*(\d{2,3})\s*k\s*[-–~]\s*\$?\s*(\d{2,3})\s*k/i,
  /\$\s*(\d{1,3}(?:,\d{3})*)\b/i, // $120,000
];

const STOPWORDS = new Set([
  '我', '想', '找', '的', '要', '做', '一个', '一份', '工作', '岗位', '职位', '要求', '最好', '希望',
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'and', 'or', 'job', 'jobs', 'role', 'position',
  'looking', 'want', 'find', 'work', 'developer', 'engineer', 'hiring',
]);

/** 规则解析：不依赖 LLM 的确定性回落（queries 至少 1 条，满足契约）。 */
export function ruleFallback(query: string): SearchConditions {
  const cleaned = query.replace(/\s+/g, ' ').trim();
  let location: string | null = null;
  for (const [hint, canonical] of LOCATION_HINTS) {
    if (cleaned.toLowerCase().includes(hint.toLowerCase())) {
      location = canonical;
      break;
    }
  }
  const remote = REMOTE_HINTS.test(cleaned);
  let salaryMinUsd: number | null = null;
  for (const pattern of SALARY_USD_PATTERNS) {
    const m = cleaned.match(pattern);
    if (m && m[1]) {
      const n = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(n)) {
        salaryMinUsd = m[0].includes('k') ? n * 1000 : n;
        break;
      }
    }
  }
  // 关键词：去掉停用词与地区词后保留有信息量的词（上限 20）
  const tokens = cleaned
    .split(/[,\s，。；、]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}+#.]+/gu, ''))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t.toLowerCase()))
    .slice(0, 20);
  const queries = buildQueries(cleaned, location, remote);
  return {
    queries,
    location,
    remote,
    salaryMinUsd,
    keywords: tokens,
  };
}

/** 生成实际搜索 query 列表（去重、最多 5 条、每条 ≤200 字符） */
export function buildQueries(cleaned: string, location: string | null, remote: boolean): string[] {
  const base = cleaned.slice(0, 200);
  const candidates: string[] = [base];
  // 变体：岗位+地点
  if (location && location.toLowerCase() !== 'remote' && !base.toLowerCase().includes(location.toLowerCase())) {
    candidates.push(`${base.slice(0, 120)} ${location}`.trim());
  }
  // 变体：远程岗位
  if (remote && !/remote|远程/i.test(base)) {
    candidates.push(`${base.slice(0, 120)} remote`.trim());
  }
  // 去重（大小写不敏感）后截 5 条
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of candidates) {
    const key = q.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(q);
    }
    if (out.length >= 5) break;
  }
  return out;
}
