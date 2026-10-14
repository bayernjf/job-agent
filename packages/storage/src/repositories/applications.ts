import type {
  ApplicationPatch,
  ApplicationStage,
  NewApplication,
  NewApplicationEvent,
  StoredApplication,
  StoredApplicationEvent,
} from '../entities/index.js';

/**
 * applications 仓储契约——求职者画像侧投递记录（痛点解决方案批次 2）。
 * 业务模块只依赖此异步接口，不感知 SQLite/Postgres 方言。
 * 读写以 profileId 为作用域；013 起另带行级归属（决策 #17-F11）。
 */
export interface IApplicationsRepository {
  insert(application: NewApplication): Promise<void>;
  getById(id: string): Promise<StoredApplication | undefined>;
  /** 列出某画像的全部投递，按 applied_at 倒序 */
  listByProfile(profileId: string): Promise<StoredApplication[]>;
  /** B3-b：列出投递到某岗位（job_postings.id）的全部记录，按 applied_at 倒序——招聘方自建岗位 pipeline 数据源 */
  listByJobId(jobId: string): Promise<StoredApplication[]>;
  /**
   * 局部更新状态/备注/投递时间/链接；不存在返回 undefined。
   *
   * `ownerAccountId` 一旦传入即启用**行级归属校验**：目标行有主且主不是该账号时
   * 返回 undefined（调用方据此回 404，不区分"不存在"与"不归你"，避免泄露他人
   * 投递记录的存在性）；无主行（013 之前的历史行与匿名写入）沿用现状仍可改。
   * **不传则完全不校验** —— 因此面向用户的端点必须传，内部批量推进才可省略。
   */
  update(
    id: string,
    patch: ApplicationPatch,
    ownerAccountId?: string | null,
  ): Promise<StoredApplication | undefined>;
  /** 物理删除某画像的全部投递（B2 自助删除画像时级联调用），无行也成功 */
  deleteByProfile(profileId: string): Promise<void>;
  /**
   * B3-b：招聘方 pipeline 阶段推进（迁移 039）。CAS 语义——`expectStage` 必须等于
   * 当前 stage（首次推进传 null），否则影响 0 行返回 undefined（并发下调用方回 409，
   * 零事件写入）。成功时**同一事务**写入一条 application_events，保证行状态与
   * 可回放事件流永远一致（对齐 job_run_events 惯例）。迁移合法性由调用方
   * （API 层）依据 APPLICATION_STAGE_TRANSITIONS 预校验，仓储不重复判合法。
   */
  advanceStage(
    id: string,
    expectStage: ApplicationStage | null,
    toStage: ApplicationStage,
    event: NewApplicationEvent,
  ): Promise<StoredApplication | undefined>;
  /** B3-b：某投递的阶段事件流（只追加审计，created_at 正序回放） */
  listStageEvents(applicationId: string): Promise<StoredApplicationEvent[]>;
}
