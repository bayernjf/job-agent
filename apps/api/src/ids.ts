import { randomBytes } from 'node:crypto';

let seq = 0;

/**
 * Time-ordered ID (ULID-style): `<prefix>-<ms-time-base36>-<monotonic-counter>-<random>`.
 *
 * Lexicographic order equals creation order, so it can serve as a stable
 * ORDER BY tiebreaker when two rows share the same millisecond timestamp
 * (a plain random UUID cannot). The counter guarantees per-process ordering
 * within the same millisecond; cross-instance ordering rests on the timestamp.
 */
export function timeOrderedId(prefix: string): string {
  seq = (seq + 1) & 0xfffff;
  const time = Date.now().toString(36);
  const counter = seq.toString(36).padStart(4, '0');
  const rand = randomBytes(3).toString('hex');
  return `${prefix}-${time}-${counter}-${rand}`;
}
