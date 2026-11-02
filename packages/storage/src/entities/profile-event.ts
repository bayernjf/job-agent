/**
 * profile_events 表实体（迁移 043，评审 P1-1 修复）。
 * append-only 画像归属/破坏性操作审计：首事件 'deleted'，在级联清空
 * evidence/applications/interviews 之前落库，保证误删/冒名删后有据可查。
 * 与 funnel_events 的匿名口径相反：审计必须可追责，故记 actor_account_id。
 */
export interface ProfileEventRecord {
  /** 事件主键（pev-<uuid>，由 API 层生成） */
  id: string;
  /** 关联画像 uuid；无 FK（画像行可能随后被删除） */
  profileId: string;
  /** 审计事件名（deleted；预留 claim/unclaim） */
  event: string;
  /** 操作者 accounts.id；系统/运营操作为 null */
  actorAccountId: string | null;
  /** JSON 上下文快照（主体 platform/login、级联行数） */
  detailJson: string | null;
  /** 事件时间（UTC ISO8601，由调用方注入） */
  createdAt: string;
}

/** Drizzle schema 已完成 snake_case ↔ camelCase 列名映射，原始行与记录同形 */
export type RawProfileEventRow = ProfileEventRecord;

export function toProfileEventRecord(row: RawProfileEventRow): ProfileEventRecord {
  return { ...row };
}
