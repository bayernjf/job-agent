/**
 * We Work Remotely（WWR）RSS 采集适配器（P2 补源）。
 *
 * WWR 没有结构化岗位 API，只有官方 RSS feed（XML）。每条 item 的关键字段：
 *   - title：恒为 `Company: Job Title`（公司名嵌在标题里，无独立字段，按首个冒号拆分）；
 *   - region：可申请地区（如 `Anywhere in the World` / `Europe` / `Helsinki`）；
 *   - category / type：职能分类与雇佣类型（并入 tags）；
 *   - description：实体转义的 HTML 正文；
 *   - pubDate：RFC822 时间；guid / link：同一岗位详情页 URL（slug 作 jobId）。
 * 整站内容均为远程岗，remote 恒为 true。
 *
 * 该源受 Cloudflare 保护：直连可能返回挑战页，生产需配置 JOB_HTTP_PROXY。
 *
 * 保守原则：缺 title 或 title 不含冒号（拆不出公司名）时整条跳过，不臆造公司。
 */
import type { JobSource } from '@jobagent/shared';
import { buildMany, type RawPostingCandidate } from './builder.js';
import type { CollectContext, CollectResult, JobSourceAdapter } from './types.js';
import { collapseWhitespace, decodeEntities, stripHtml } from '../normalize/html.js';
import { toPostedIso } from '../normalize/date.js';

export const WWR_ENDPOINT = 'https://weworkremotely.com/remote-jobs.rss';

const ITEM_RE = /<item>([\s\S]*?)<\/item>/gi;
const MEDIA_CONTENT_URL_RE = /<media:content\b[^>]*\burl\s*=\s*["']([^"']+)["']/i;

/** 取首个 `<tag>...</tag>` 内容并 trim（缺失返回空串）；WWR feed 无 CDATA。 */
function pickTag(itemXml: string, tag: string): string {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(itemXml);
  return m?.[1]?.trim() ?? '';
}

function toCandidate(itemXml: string, fetchedAt: string): RawPostingCandidate | undefined {
  const rawTitle = pickTag(itemXml, 'title');
  if (rawTitle.length === 0) return undefined;

  // title 恒为 `Company: Job Title`；按首个冒号拆分（标题正文里的冒号保留）
  const decodedTitle = collapseWhitespace(decodeEntities(rawTitle));
  const colon = decodedTitle.indexOf(':');
  if (colon <= 0) return undefined; // 无冒号或冒号在首位：拆不出公司名，保守跳过
  const company = decodedTitle.slice(0, colon).trim();
  const title = decodedTitle.slice(colon + 1).trim();
  if (company.length === 0 || title.length === 0) return undefined;

  const sourceUrl = pickTag(itemXml, 'link') || pickTag(itemXml, 'guid');
  const slug = sourceUrl.replace(/\/+$/, '').split('/').pop() ?? '';

  const region = collapseWhitespace(decodeEntities(pickTag(itemXml, 'region')));
  const category = collapseWhitespace(decodeEntities(pickTag(itemXml, 'category')));
  const jobType = collapseWhitespace(decodeEntities(pickTag(itemXml, 'type')));
  const tags = [category, jobType].filter((t) => t.length > 0);

  const logo = MEDIA_CONTENT_URL_RE.exec(itemXml)?.[1];

  return {
    jobId: slug || sourceUrl,
    source: 'weworkremotely' satisfies JobSource,
    sourceUrl,
    title,
    company,
    location: region || null,
    remote: true,
    tags,
    description: stripHtml(pickTag(itemXml, 'description')),
    postedAt: toPostedIso(pickTag(itemXml, 'pubDate'), fetchedAt),
    fetchedAt,
    ...(logo ? { companyLogoUrl: decodeEntities(logo) } : {}),
  };
}

/** 纯函数：解析 WWR RSS 文本（黄金路径单测入口）。 */
export function parseWwrRss(xml: string, fetchedAt: string): CollectResult {
  const items = xml.match(ITEM_RE) ?? [];
  return buildMany(items, (itemXml) => toCandidate(itemXml, fetchedAt));
}

export class WeworkRemotelyAdapter implements JobSourceAdapter {
  readonly source: JobSource = 'weworkremotely';

  async collect(ctx: CollectContext): Promise<CollectResult> {
    const xml = await ctx.http.getText(WWR_ENDPOINT);
    return parseWwrRss(xml, ctx.fetchedAt);
  }
}