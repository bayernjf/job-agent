/**
 * ATS 适配器单测：纯函数部分（toFillValues / valueFor）+ detect 的 DOM 判定。
 * 不依赖真实浏览器 DOM，用最小 fake Document。
 */
import { describe, expect, it } from 'vitest';
import type { ExportableProfile } from '@jobagent/shared';
import { detectAts, findFields, listAdapters, toFillValues, valueFor } from './index.js';

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

  it('uses Gitee platform label in summary for gitee profiles', () => {
    const p = profile({
      subject: {
        platform: 'gitee',
        login: 'gitee-dev',
        displayName: 'Gitee Dev',
        profileUrl: 'https://gitee.com/gitee-dev',
        claimed: false,
      },
    });
    const values = toFillValues(p, {});
    const byKey = Object.fromEntries(values.map((v) => [v.key, v.value]));
    expect(byKey.summary).toContain('Gitee 验证');
    expect(byKey.github_url).toBe('https://gitee.com/gitee-dev');
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

describe('greenhouse summary → question_* mapping', () => {
  const greenhouseAdapter = listAdapters().find((a) => a.id === 'greenhouse')!;

  function fakeQuestionDoc(): { doc: Document; why: HTMLTextAreaElement; salary: HTMLInputElement } {
    const why = {
      id: 'question_123',
      name: 'job_application[answers][123]',
      value: '',
      placeholder: '',
      getAttribute: (attr: string) => (attr === 'id' ? 'question_123' : null),
      closest: () => null,
      dispatchEvent: () => true,
    } as unknown as HTMLTextAreaElement;
    const salary = {
      id: 'question_456',
      name: 'job_application[answers][456]',
      value: '',
      placeholder: '',
      getAttribute: (attr: string) => (attr === 'id' ? 'question_456' : null),
      closest: () => null,
      dispatchEvent: () => true,
    } as unknown as HTMLInputElement;
    const labels: Record<string, { textContent: string }> = {
      question_123: { textContent: 'Why do you want to work here? *' },
      question_456: { textContent: 'What is your salary expectation? *' },
    };
    const doc = {
      querySelectorAll: (sel: string) => {
        const out: unknown[] = [];
        if (sel.includes('textarea')) out.push(why);
        if (sel.includes('input')) out.push(salary);
        return out;
      },
      querySelector: (sel: string) => {
        const m = sel.match(/^label\[for="([^"]+)"\]$/);
        return m && m[1] ? (labels[m[1]] ?? null) : null;
      },
    } as unknown as Document;
    return { doc, why, salary };
  }

  const fillValues = [
    { key: 'full_name' as const, value: 'Demo Dev' },
    { key: 'github_url' as const, value: 'https://github.com/demo-dev' },
    { key: 'headline' as const, value: 'TypeScript 后端工程师' },
    { key: 'summary' as const, value: 'TypeScript 后端工程师，开源维护者。' },
    { key: 'skills' as const, value: 'TypeScript' },
  ];

  it('writes summary into a motivation-style custom question', () => {
    const { doc, why, salary } = fakeQuestionDoc();
    const written = greenhouseAdapter.fill(doc, fillValues);
    expect(written).toBe(1);
    expect(why.value).toBe('TypeScript 后端工程师，开源维护者。');
    expect(salary.value).toBe('');
  });

  it('keeps written count at zero when no summary-like question exists', () => {
    const salary = {
      id: 'question_456',
      name: 'job_application[answers][456]',
      value: '',
      placeholder: '',
      getAttribute: (attr: string) => (attr === 'id' ? 'question_456' : null),
      closest: () => null,
      dispatchEvent: () => true,
    } as unknown as HTMLInputElement;
    const doc = {
      querySelectorAll: (sel: string) => (sel.includes('input') ? [salary] : []),
      querySelector: (sel: string) => (sel.includes('question_456') ? { textContent: 'What is your salary expectation? *' } : null),
    } as unknown as Document;
    const written = greenhouseAdapter.fill(doc, fillValues);
    expect(written).toBe(0);
    expect(salary.value).toBe('');
  });

  // 2026-09-18: SUMMARY_HINTS covers common real-world self-statement / supplement wording
  function docWithQuestions(
    questions: Array<{ id: string; label: string; kind?: 'textarea' | 'input' }>,
  ): { doc: Document; fields: Record<string, { value: string }> } {
    const fields: Record<string, { value: string }> = {};
    const labelMap: Record<string, string> = {};
    const textareas: unknown[] = [];
    const inputs: unknown[] = [];
    for (const q of questions) {
      const field = {
        id: q.id,
        name: `job_application[answers][${q.id}]`,
        value: '',
        placeholder: '',
        getAttribute: (attr: string) => (attr === 'id' ? q.id : null),
        closest: () => null,
        dispatchEvent: () => true,
      };
      fields[q.id] = field as unknown as { value: string };
      labelMap[q.id] = q.label;
      (q.kind === 'input' ? inputs : textareas).push(field);
    }
    const doc = {
      querySelectorAll: (sel: string) => {
        const out: unknown[] = [];
        if (sel.includes('textarea')) out.push(...textareas);
        if (sel.includes('input')) out.push(...inputs);
        return out;
      },
      querySelector: (sel: string) => {
        const m = sel.match(/^label\[for="([^"]+)"\]$/);
        return m?.[1] && labelMap[m[1]] ? { textContent: labelMap[m[1]] } : null;
      },
    } as unknown as Document;
    return { doc, fields };
  }

  it('writes summary into other self-statement / supplement style questions', () => {
    const { doc, fields } = docWithQuestions([
      { id: 'question_a', label: 'Anything else you would like us to know? *' },
      { id: 'question_b', label: 'What makes you a great candidate for this role?' },
      { id: 'question_c', label: 'Describe your background in your own words.' },
    ]);
    const written = greenhouseAdapter.fill(doc, fillValues);
    // First document-order hint hit (anything else) receives the summary; others stay empty
    expect(written).toBe(1);
    expect(fields.question_a!.value).toBe('TypeScript 后端工程师，开源维护者。');
    expect(fields.question_b!.value).toBe('');
    expect(fields.question_c!.value).toBe('');
  });

  it('does not write summary into referral, link, authorization or years-of-experience questions', () => {
    const { doc, fields } = docWithQuestions([
      { id: 'question_a', label: 'How did you hear about this position?', kind: 'input' },
      { id: 'question_b', label: 'Please share a link to your portfolio or website.', kind: 'input' },
      { id: 'question_c', label: 'Are you legally authorized to work in the EU?', kind: 'input' },
      { id: 'question_d', label: 'How many years of experience do you have?', kind: 'input' },
    ]);
    const written = greenhouseAdapter.fill(doc, fillValues);
    expect(written).toBe(0);
    for (const f of Object.values(fields)) expect(f.value).toBe('');
  });
});

describe('lever summary → questions[*] mapping', () => {
  const leverAdapter = listAdapters().find((a) => a.id === 'lever')!;

  it('writes summary into a motivation-style custom question', () => {
    const why = {
      id: 'question_abc',
      name: 'questions[abc]',
      value: '',
      placeholder: '',
      getAttribute: (attr: string) => (attr === 'id' ? 'question_abc' : null),
      closest: () => null,
      dispatchEvent: () => true,
    } as unknown as HTMLTextAreaElement;
    const salary = {
      id: 'question_def',
      name: 'questions[def]',
      value: '',
      placeholder: '',
      getAttribute: (attr: string) => (attr === 'id' ? 'question_def' : null),
      closest: () => null,
      dispatchEvent: () => true,
    } as unknown as HTMLInputElement;
    const doc = {
      querySelectorAll: (sel: string) => {
        const out: unknown[] = [];
        if (sel.includes('textarea')) out.push(why);
        if (sel.includes('input')) out.push(salary);
        return out;
      },
      querySelector: (sel: string) => {
        const m = sel.match(/^label\[for="([^"]+)"\]$/);
        if (m?.[1] === 'question_abc') return { textContent: 'Why do you want to work at Acme? *' };
        if (m?.[1] === 'question_def') return { textContent: 'What is your salary expectation? *' };
        return null;
      },
    } as unknown as Document;
    const values = [
      { key: 'full_name' as const, value: 'Demo Dev' },
      { key: 'github_url' as const, value: 'https://github.com/demo-dev' },
      { key: 'headline' as const, value: 'TypeScript 后端工程师' },
      { key: 'summary' as const, value: 'TypeScript 后端工程师，开源维护者。' },
      { key: 'skills' as const, value: 'TypeScript' },
    ];
    const written = leverAdapter.fill(doc, values);
    expect(written).toBe(1);
    expect(why.value).toBe('TypeScript 后端工程师，开源维护者。');
    expect(salary.value).toBe('');
  });
});
