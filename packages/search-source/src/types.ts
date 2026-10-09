/**
 * search-source 公共类型（指令式全网搜岗，design-websearch-job-discovery §2/§6）。
 *
 * 核心不变量：
 * - **确定性执行**：搜索任务的执行（run.ts）只消费已解析好的 `SearchConditions`，
 *   意图解析只在创建时（POST /agent/search / 保存预设）发生，且 LLM 失败即回落规则；
 * - **凭证隔离**：Tavily API key 只从服务端 env（TAVILY_API_KEY）读取，构造时注入，
 *   不进 Git / 构建产物 / 前端；
 * - **测试确定性**：测试一律用 fake SearchClient / fake LlmClient（AGENTS：不调真实外部）。
 */

/** 一次搜索返回的单条结果（Tavily search 响应 results[] 的收敛形状）。 */
export interface SearchResultItem {
  title: string;
  url: string;
  /** 内容摘要（Tavily chunks 拼接；extract 全文未启用时即全部可用文本） */
  content: string;
  score: number;
  publishedDate?: string | null;
}

/** 搜索通道最小抽象（Tavily 为主实现；SerpAPI Google Jobs 为 P1 备选实现）。 */
export interface SearchClient {
  readonly provider: string;
  search(
    query: string,
    opts?: {
      maxResults?: number;
      /** 限定结果域名（Tavily include_domains）；用于 ATS 域混合召回 */
      includeDomains?: string[];
    },
  ): Promise<SearchResultItem[]>;
}

/** 意图解析结果：LLM 成功产出或规则回落，都必须满足 shared 的 SearchConditionsSchema。 */
export type { SearchConditions } from '@jobagent/shared';
