import { describe, expect, it } from 'vitest';
import { inferRemote, workplaceTypeToRemote } from './remote.js';

describe('workplaceTypeToRemote', () => {
  it('maps Lever workplace types', () => {
    expect(workplaceTypeToRemote('remote')).toBe(true);
    expect(workplaceTypeToRemote('onsite')).toBe(false);
    expect(workplaceTypeToRemote('hybrid')).toBe(false);
    expect(workplaceTypeToRemote(undefined)).toBeUndefined();
  });
});

describe('inferRemote', () => {
  it('prefers explicit boolean', () => {
    expect(inferRemote(true, 'Onsite location')).toBe(true);
    expect(inferRemote(false, 'Remote worldwide')).toBe(false);
  });

  it('falls back to text matching', () => {
    expect(inferRemote(undefined, 'Remote - US')).toBe(true);
    expect(inferRemote(undefined, 'Worldwide')).toBe(true);
    expect(inferRemote(undefined, 'Berlin, Germany')).toBe(false);
  });
});
