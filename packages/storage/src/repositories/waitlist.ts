import type {
  NewWaitlist,
  StoredWaitlist,
  WaitlistStatus,
} from '../entities/index.js';

/** waitlist 仓储契约（落地页留资），业务模块只依赖此接口。 */
export interface IWaitlistRepository {
  insert(entry: NewWaitlist): Promise<void>;
  getById(id: string): Promise<StoredWaitlist | undefined>;
  getByEmail(email: string): Promise<StoredWaitlist | undefined>;
  listByStatus(status: WaitlistStatus, limit?: number): Promise<StoredWaitlist[]>;
  listAll(limit?: number): Promise<StoredWaitlist[]>;
  updateStatus(id: string, status: WaitlistStatus): Promise<void>;
  updateNotes(id: string, notes: string): Promise<void>;
  countByStatus(): Promise<Record<WaitlistStatus, number>>;
}
