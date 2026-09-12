/**
 * ATS 适配器单测：纯函数部分（toFillValues / valueFor）+ detect 的 DOM 判定。
 * 不依赖真实浏览器 DOM，用最小 fake Document。
 */
import { describe, expect, it } from 'vitest';
import type { ExportableProfile } from '@jobagent/shared';
import { detectAts, findFields, toFillValues, valueFor } from './index.js';

function profile(overrides: Partial<ExportableProfile> = {}): ExportableProfile {
  return {
    schemaVersion: '0.1',
    profileId: 'prof-1',
    generatedAt: '2026-09-12T00:00:00.000Z',
    analyzerVersion: '0.1.0',
    subject: {
      platform: 'github',
      login: 'demo-dev',
      displayName: 'Demo Dev',
      profileUrl: 'https://github.com/demo-dev',
      claimed: false,
    },
    headline: 'TypeScript 后端工程师，开源维护者',
    skills: [
      {
        name: 'TypeScript',
        kind: 'language',
        depth: 'proficient',
        confidence: 0.9,
        evidenceRefs: ['repo:demo:typescript'],
      },
    ],
    authenticity: { status: 'likely_authentic', confidence: 0.85 },
    ...overrides,
  };
}

function fakeDoc(html: string): Document {
  // 只支持本适配器用到的 querySelector / querySelectorAll / outerHTML 语义的极简 fake
  return {
    documentElement: { outerHTML: html },
    querySelector(selector: string): Element | null {
      if (selector.includes('#application_form') && html.includes('application_form')) return {} as Element;
      if (selector.includes('#job-application-form') && html.includes('job-application-form')) return {} as Element;
      return null;
    },
    querySelectorAll(): [] {
      return [];
    },
  } as unknown as Document;
}

describe('toFillValues', () => {
  it('maps verified profile fields to semantic fill values', () => {
    const values = toFillValues(profile(), {});
    const byKey = Object.fromEntries(values.map((v) => [v.key, v.value]));
    expect(byKey.full_name).toBe('Demo Dev');
    expect(byKey.github_url).toBe('https://github.com/demo-dev');
    expect(byKey.headline).toBe('TypeScript 后端工程师，开源维护者');
    expect(byKey.skills).toBe('TypeScript');
    expect(byKey.summary).toContain('GitHub 验证');
    expect(byKey.summary).toContain('TypeScript (0.9)');
  });

  it('falls back to login when displayName is missing', () => {
    const p = profile();
    delete (p.subject as { displayName?: string }).displayName;
    const values = toFillValues(p, {});
    expect(valueFor(values, 'full_name')).toBe('demo-dev');
  });

  it('merges local supplemental fields without uploading them', () => {
    const values = toFillValues(profile(), {
      email: 'a@b.com',
      phone: '123',
      location: 'Hangzhou',
      linkedinUrl: 'https://linkedin.com/in/a',
      education: [{ school: 'ZJU', degree: 'BS' }],
      experience: [{ company: 'ACME', title: 'SDE' }],
    });
    const byKey = Object.fromEntries(values.map((v) => [v.key, v.value]));
    expect(byKey.email).toBe('a@b.com');
    expect(byKey.phone).toBe('123');
    expect(byKey.location).toBe('Hangzhou');
    expect(byKey.linkedin_url).toBe('https://linkedin.com/in/a');
    expect(byKey.education).toContain('ZJU');
    expect(byKey.experience).toContain('ACME');
  });

  it('omits absent local fields', () => {
    const values = toFillValues(profile(), {});
    expect(valueFor(values, 'email')).toBeUndefined();
    expect(valueFor(values, 'phone')).toBeUndefined();
  });
});

describe('detectAts', () => {
  it('detects Greenhouse by form id', () => {
    const doc = fakeDoc('<html><body><form id="application_form"></form></body></html>');
    expect(detectAts(doc)?.id).toBe('greenhouse');
  });

  it('detects Lever by form selector', () => {
    const doc = fakeDoc('<html><body><form id="job-application-form"></form></body></html>');
    expect(detectAts(doc)?.id).toBe('lever');
  });

  it('returns null on unsupported pages', () => {
    const doc = fakeDoc('<html><body><p>random</p></body></html>');
    expect(detectAts(doc)).toBeNull();
  });
});

describe('findFields', () => {
  function fakeInput(name: string): HTMLInputElement {
    return {
      name,
      value: '',
      placeholder: '',
      getAttribute: (attr: string) => (attr === 'aria-label' ? null : null),
      dispatchEvent: () => true,
    } as unknown as HTMLInputElement;
  }

  it('matches fields by name keyword', () => {
    const doc = {
      querySelectorAll: (sel: string) => (sel.startsWith('input') ? [fakeInput('email')] : []),
    } as unknown as Document;
    const hits = findFields(doc, ['email']);
    expect(hits).toHaveLength(1);
  });

  it('does not match unrelated keywords', () => {
    const doc = {
      querySelectorAll: (sel: string) => (sel.startsWith('input') ? [fakeInput('candidate_country')] : []),
    } as unknown as Document;
    expect(findFields(doc, ['github'])).toHaveLength(0);
  });
});
