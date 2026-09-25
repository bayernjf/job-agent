import type { EvidenceItem } from '@jobagent/shared';
import type { NewEvidence, StoredEvidence } from '../entities/index.js';

/** evidence 仓储契约（证据项索引），业务模块只依赖此接口。 */
export interface IEvidenceRepository {
  insert(ev: NewEvidence): Promise<void>;
  insertBatch(evidence: NewEvidence[]): Promise<void>;
  importFromProfile(profileId: string, items: EvidenceItem[]): Promise<void>;
  /** 按 (画像, evidenceId) 取单条：014 起 evidenceId 只在画像内唯一，故必须带 profileId */
  getById(profileId: string, id: string): Promise<StoredEvidence | undefined>;
  listByProfile(profileId: string): Promise<StoredEvidence[]>;
  listBySource(
    sourcePlatform: string,
    sourceType: string,
    limit?: number,
  ): Promise<StoredEvidence[]>;
  countByProfile(profileId: string): Promise<number>;
  /** 物理删除某画像的全部证据（T26 删除画像/解绑时随画像一起清）；行不存在时静默 */
  deleteByProfile(profileId: string): Promise<void>;
}
