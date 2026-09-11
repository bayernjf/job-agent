import { describe, expect, it } from 'vitest';
import { computeSkillTags } from './skills.js';
import { buildInput } from './test-input.js';
import type { AnalyzerInput } from './input.js';

function expectValidRefs(input: AnalyzerInput, tags: ReturnType<typeof computeSkillTags>): void {
  const known = new Set(input.evidence.map((e) => e.evidenceId));
  for (const tag of tags) {
    expect(tag.evidenceRefs.length).toBeGreaterThan(0);
    for (const ref of tag.evidenceRefs) {
      expect(known.has(ref), `tag ${tag.name} references unknown evidence ${ref}`).toBe(true);
    }
  }
}

describe('computeSkillTags', () => {
  it('derives language tags from repo primary languages with depth', () => {
    const input = buildInput();
    const tags = computeSkillTags(input);
    const languages = tags.filter((t) => t.kind === 'language');
    expect(languages.map((l) => l.name)).toContain('TypeScript');
    expect(languages.find((l) => l.name === 'TypeScript')?.depth).toBe('proficient'); // 3 repos + active
    expect(languages.find((l) => l.name === 'Go')?.depth).toBe('used');
    expectValidRefs(input, tags);
  });

  it('matches frameworks and domains from topics and description', () => {
    const input = buildInput();
    const tags = computeSkillTags(input);
    const frameworks = tags.filter((t) => t.kind === 'framework').map((t) => t.name);
    expect(frameworks).toContain('react');
    expect(frameworks).toContain('hono');
    const domains = tags.filter((t) => t.kind === 'domain').map((t) => t.name);
    expect(domains).toContain('backend');
    expect(domains).toContain('data-ml');
    expectValidRefs(input, tags);
  });

  it('returns empty tags for an account without repos', () => {
    const input = buildInput({ repos: [], commits: [], pullRequests: [], issues: [] });
    expect(computeSkillTags(input)).toEqual([]);
  });
});
