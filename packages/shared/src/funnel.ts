import { z } from 'zod';

/**
 * 产品验证漏斗事件契约（PRD §11.2，2026-10-15，迁移 040 funnel_events）。
 *
 * 与 usage.ts 的成本计量互补：usage_events 回答"哪个功能在烧钱"，
 * funnel_events 回答"访客在验证漏斗上走到哪一步"。
 *
 * 隐私硬约束（design-funnel-analytics-20261015 §2）：
 * 不记账号 id / IP / 被分析用户名 / UA；会话串联只用 24h 随机 ja_sid。
 */

/**
 * 匿名会话标识 Cookie 名（design §2-3）：报告页 SSR 种/读，API 侧只读。
 * 24h Max-Age、HttpOnly、SameSite=Lax、Path=/；不与账号/demo 会话/IP 哈希 join。
 */
export const FUNNEL_SESSION_COOKIE = 'ja_sid';

/** 四类漏斗事件；客户端公开端点只允许写 share_clicked */
export const FUNNEL_EVENTS = [
  'analyze_enqueued', // POST /analyze 新建分析作业成功
  'analyze_cache_hit', // POST /analyze 命中未过期 complete 画像
  'report_viewed', // 报告页 SSR 成功查看（30 分钟会话内去重）
  'share_clicked', // 报告页分享按钮点按（前端回传）
] as const;
export const FunnelEventNameSchema = z.enum(FUNNEL_EVENTS);
export type FunnelEventName = z.infer<typeof FunnelEventNameSchema>;

/** 客户端经公开端点可上报的事件白名单（其余三类只允许服务端写） */
export const CLIENT_FUNNEL_EVENTS = ['share_clicked'] as const;
export const ClientFunnelEventNameSchema = z.enum(CLIENT_FUNNEL_EVENTS);
export type ClientFunnelEventName = z.infer<typeof ClientFunnelEventNameSchema>;

/** 触发者口径（不记账号 id）；不适用为 null */
export const FUNNEL_REQUESTERS = ['user', 'demo', 'visitor'] as const;
export const FunnelRequesterSchema = z.enum(FUNNEL_REQUESTERS);
export type FunnelRequester = z.infer<typeof FunnelRequesterSchema>;

/**
 * 记录一条漏斗事件的输入（recorder 入参）。
 * id 与 created_at 不在此结构内——由 recorder 注入（fe-<uuid> / UTC ISO8601）。
 */
export const RecordFunnelInputSchema = z.object({
  event: FunnelEventNameSchema,
  /** ja_sid 匿名会话标识（24h 随机）；非浏览器来源（CLI/扩展）为 null */
  sessionRef: z.string().min(1).nullable(),
  /** 画像 id（uuid 形态，不可枚举）；仅 report_viewed / share_clicked 可带 */
  profileId: z.string().uuid().nullable().optional(),
  /** 触发者口径；analyze_cache_hit / share_clicked 不区分给 null */
  requester: FunnelRequesterSchema.nullable().optional(),
});
export type RecordFunnelInput = z.infer<typeof RecordFunnelInputSchema>;

/** POST /funnel/events 请求体（客户端只可上报白名单事件） */
export const RecordClientFunnelEventSchema = z.object({
  event: ClientFunnelEventNameSchema,
  profileId: z.string().uuid().nullable().optional(),
});
export type RecordClientFunnelEvent = z.infer<typeof RecordClientFunnelEventSchema>;

/** 汇总查询窗口；sinceIso 含、untilIso 不含（省略＝至今）。 */
export const FunnelSummaryQuerySchema = z.object({
  sinceIso: z.string().min(1),
  untilIso: z.string().min(1).optional(),
});
export type FunnelSummaryQuery = z.infer<typeof FunnelSummaryQuerySchema>;

/** 按事件聚合的汇总行：总次数 + 去重会话数 + 无会话标识的次数 */
export const FunnelSummaryRowSchema = z.object({
  event: FunnelEventNameSchema,
  events: z.number().int().nonnegative(),
  distinctSessions: z.number().int().nonnegative(),
  nullSessions: z.number().int().nonnegative(),
});
export type FunnelSummaryRow = z.infer<typeof FunnelSummaryRowSchema>;

/** 按自然日（UTC，'YYYY-MM-DD'）+ 事件分组的每日趋势行 */
export const FunnelDailyRowSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  event: FunnelEventNameSchema,
  events: z.number().int().nonnegative(),
});
export type FunnelDailyRow = z.infer<typeof FunnelDailyRowSchema>;
