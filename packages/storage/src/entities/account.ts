/**
 * accounts 实体：经平台 OAuth 登录的正式用户账号（账号里程碑，2026-09-18，
 * 决策 #1-A / #6-A）。
 *
 * 与方言无关的领域类型 + 纯映射逻辑（sqlite/postgres 两套仓储共享）。
 * 一个平台身份（platform + providerAccountId）对应一行；登录名 login 必须与
 * profiles.subject_login 一致才允许认领该画像。email 仅服务端留存、不随 API 外发。
 */
import type { SupportedPlatform } from '@jobagent/shared';

export interface StoredAccount {
  /** 内部稳定 id：acc-<uuid> */
  id: string;
  platform: SupportedPlatform;
  /** 平台侧数字用户 id（按文本存储） */
  providerAccountId: string;
  /** 平台登录名 */
  login: string;
  name: string | null;
  /** 尽力获取的邮箱，可空；服务端留存，绝不随对外身份响应外发 */
  email: string | null;
  avatarUrl: string | null;
  /** 本人认领的画像快照 id，未认领为 null */
  claimedProfileId: string | null;
  /**
   * 招聘方显式自声明时刻（F10，决策 #17 第一期，UTC ISO8601）。
   * null=未声明；声明后永不因重新登录或后台清理被静默重置。
   */
  recruiterDeclaredAt: string | null;
  /** 平台管理员标记（迁移 023，决策 #21-5）：admin 面（LLM 目录等）鉴权用 */
  isAdmin: boolean;
  createdAt: string;
  updatedAt: string;
}

/** OAuth 回调从平台拿到的身份资料（upsert 输入的平台部分） */
export interface ProviderIdentity {
  platform: SupportedPlatform;
  providerAccountId: string;
  login: string;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

/** 新建账号：内部 id 由调用方生成，其余来自平台身份 */
export interface NewAccount extends ProviderIdentity {
  id: string;
}

/** Drizzle 查询返回的原始行（camelCase），两方言结构一致 */
export interface RawAccountRow {
  id: string;
  platform: string;
  providerAccountId: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  claimedProfileId: string | null;
  recruiterDeclaredAt?: string | null;
  /** 方言差异：sqlite 返回 0/1（number），pg 返回 boolean；映射时用 Boolean() 归一 */
  isAdmin?: boolean | number;
  createdAt: string;
  updatedAt: string;
}

/** 非法/未知平台值兜底为 github（与既有平台字段处理保持一致的保守默认）。 */
export function toStoredAccount(row: RawAccountRow): StoredAccount {
  const platform: SupportedPlatform = row.platform === 'gitee' ? 'gitee' : 'github';
  return {
    id: row.id,
    platform,
    providerAccountId: row.providerAccountId,
    login: row.login,
    name: row.name ?? null,
    email: row.email ?? null,
    avatarUrl: row.avatarUrl ?? null,
    claimedProfileId: row.claimedProfileId ?? null,
    recruiterDeclaredAt: row.recruiterDeclaredAt ?? null,
    isAdmin: Boolean(row.isAdmin),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
