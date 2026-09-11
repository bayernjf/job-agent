import type { EvidenceItem } from '@jobagent/shared';
import type { NewEvidence, StoredEvidence } from '../entities/index.js';

/** evidence 仓储契约（证据项索引），业务模块只依赖此接口。 */
export interface IEvidenceRepository {
  insert(ev: NewEvidence): Promise<void>;
  insertBatch(evidence: NewEvidence[]): Promise<void>;
  importFromProfile(profileId: string, items: EvidenceItem[]): Promise<void>;
  getById(id: string): Promise<StoredEvidence | undefined>;
  listByProfile(profileId: string): Promise<StoredEvidence[]>;
  listBySource(
    sourcePlatform: string,
    sourceType: string,
    limit?: number,
  ): Promise<StoredEvidence[]>;
  countByProfile(profileId: string): Promise<number>;
}
