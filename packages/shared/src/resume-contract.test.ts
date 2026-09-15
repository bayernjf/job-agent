import { describe, expect, it } from 'vitest';
import {
  RESUME_RULE_VERSION,
  ResumeDraftSchema,
  ResumeEntrySchema,
  LocalResumeFieldsSchema,
  parseResumeDraft,
} from './index.js';

function profileEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    text: 'typescript',
    evidenceRefs: ['ev-1'],
    source: 'profile' as const,
    supportsSkills: [],
    ...overrides,
  };
}

function validDraft(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: '0.1',
    ruleVersion: RESUME_RULE_VERSION,
    generatedAt: '2026-09-15T00:00:00.000Z',
    subject: { login: 'alice', profileUrl: 'https://github.com/alice' },
    targetJob: {
      jobId: 'j1',
      title: 'Backend Engineer',
      company: 'Acme',
      sourceUrl: 'https://example.com/jobs/j1',
      matchScore: 12,
      tier: 'high',
      matchedSkills: ['typescript'],
      fieldScores: { title: 6, tags: 4, description: 2 },
    },
    header: { name: 'Alice', headline: 'Backend developer' },
    summary: 'Backend developer strong in typescript.',
    matchedSkills: [profileEntry()],
    otherSkills: [],
    evidenceHighlights: [],
    collaboration: [],
    localSections: { education: [], workHistory: [] },
    suggestions: [],
    gaps: [],
    provenance: { profileId: 'p1', analyzerVersion: '0.1-0.2', ruleVersion: RESUME_RULE_VERSION },
    ...overrides,
  };
}

describe('resume contracts', () => {
  it('accepts a well-formed draft and fills default arrays', () => {
    const draft = ResumeDraftSchema.parse(validDraft({ collaboration: undefined, localSections: {} }));
    expect(draft.collaboration).toEqual([]);
    expect(draft.localSections.education).toEqual([]);
    expect(draft.localSections.workHistory).toEqual([]);
  });

  it('rejects a profile-sourced entry without evidenceRefs (no-fabrication)', () => {
    const result = ResumeEntrySchema.safeParse(profileEntry({ evidenceRefs: [] }));
    expect(result.success).toBe(false);
  });

  it('allows a local-sourced entry to have empty evidenceRefs', () => {
    const result = ResumeEntrySchema.safeParse({
      text: 'BSc, Example University',
      evidenceRefs: [],
      source: 'local',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown match tier', () => {
    const result = ResumeDraftSchema.safeParse(
      validDraft({ targetJob: { ...validDraft().targetJob, tier: 'excellent' } }),
    );
    expect(result.success).toBe(false);
  });

  it('parseResumeDraft returns null on malformed input', () => {
    expect(parseResumeDraft(null)).toBeNull();
    expect(parseResumeDraft({ nope: true })).toBeNull();
  });

  it('parseResumeDraft returns the draft on valid input', () => {
    expect(parseResumeDraft(validDraft())?.subject.login).toBe('alice');
  });

  it('accepts optional local fields and rejects malformed personalSite URL', () => {
    expect(LocalResumeFieldsSchema.parse({ fullName: 'Alice' }).fullName).toBe('Alice');
    const bad = LocalResumeFieldsSchema.safeParse({ personalSite: 'not-a-url' });
    expect(bad.success).toBe(false);
  });
});
