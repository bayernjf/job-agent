import { describe, expect, it } from 'vitest';
import { generateInterviewQuestions } from './questions.js';
import { buildInput } from './test-input.js';

describe('generateInterviewQuestions', () => {
  it('generates questions grounded in real evidence for a strong account', () => {
    const input = buildInput();
    const questions = generateInterviewQuestions(input);
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(q.basisEvidenceRef).toBeTruthy();
      expect(
        input.evidence.some((e) => e.evidenceId === q.basisEvidenceRef),
        `question basis ${q.basisEvidenceRef} must reference real evidence`,
      ).toBe(true);
    }
    // 应包含基于外部 merged PR 的问题
    expect(questions.some((q) => q.basisEvidenceRef.includes('pr:'))).toBe(true);
  });

  it('returns empty questions when there is no evidence (no fabrication)', () => {
    const input = buildInput({ repos: [], commits: [], pullRequests: [], issues: [] });
    expect(generateInterviewQuestions(input)).toEqual([]);
  });

  it('caps at 5 questions', () => {
    const questions = generateInterviewQuestions(buildInput());
    expect(questions.length).toBeLessThanOrEqual(5);
  });
});
