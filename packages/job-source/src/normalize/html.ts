/**
 * HTML → 纯文本：岗位正文清洗。
 *
 * 关键点：Greenhouse 的 content 字段是「双重 HTML 实体转义」的
 * （`&lt;div ...` 而非 `<div ...`），因此先做多遍实体解码再去标签。
 * 不引入第三方 HTML 解析库（岗位正文无需高保真，MVP 轻量处理）。
 */

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
  nbsp: ' ',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/** 解码数字（十进制/十六进制）与命名实体；同一次替换不递归扫描结果。 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);?/gi, (match, name: string) => {
      const key = name.toLowerCase();
      return NAMED_ENTITIES[key] ?? match;
    });
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

const BLOCK_CLOSE = /<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer)>/gi;

/** 去标签 + 折叠空白 + 截断，返回精简纯文本。 */
export function stripHtml(input: unknown, maxLen = 8000): string | null {
  if (input == null) return null;
  let s = String(input);
  if (s.trim().length === 0) return null;

  // 最多两遍实体解码，覆盖双重转义（&amp;lt; → &lt; → <）
  for (let i = 0; i < 2; i += 1) s = decodeEntities(s);

  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(BLOCK_CLOSE, '\n');
  s = s.replace(/<[^>]*>/g, ' '); // 去掉所有剩余标签
  s = decodeEntities(s); // 文本里残留的实体（如 &amp;）

  // 常见 mojibake：UTF-8 被按 Latin-1 解读产生的 Â 与不换行空白
  s = s.replace(/ /g, ' ').replace(/Â/g, '');
  s = s
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (s.length === 0) return null;
  return s.length > maxLen ? `${s.slice(0, maxLen).trimEnd()}…` : s;
}

/** 折叠任意文本为单行（用于标题/地点等）。 */
export function collapseWhitespace(input: unknown): string {
  return String(input ?? '').replace(/\s+/g, ' ').trim();
}

/** 纯文本截断（用于已是纯文本、无需去标签的正文，如 Lever descriptionPlain）。 */
export function truncateText(input: unknown, maxLen = 8000): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (s.length === 0) return null;
  return s.length > maxLen ? `${s.slice(0, maxLen).trimEnd()}…` : s;
}
