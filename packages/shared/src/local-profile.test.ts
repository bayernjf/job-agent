import { describe, expect, it } from 'vitest';
import {
  LOCAL_PROFILE_STORAGE_KEY,
  formatRange,
  splitRange,
  sanitizeLocalProfile,
  localProfileToResumeFields,
  localProfileToAtsFields,
  legacyResumeToLocalProfile,
  legacyAtsToLocalProfile,
  mergeLocalProfile,
  type LocalProfileFields,
} from './index.js';

describe('local profile canonical (item19 ①)', () => {
  it('exposes a stable canonical storage key', () => {
    expect(LOCAL_PROFILE_STORAGE_KEY).toBe('jobagent.localProfile');
  });

  describe('formatRange', () => {
    it('joins start and end with an en dash', () => {
      expect(formatRange('2018-09', '2022-06')).toBe('2018-09 – 2022-06');
    });
    it('returns the single present bound', () => {
      expect(formatRange('2018', undefined)).toBe('2018');
      expect(formatRange(undefined, 'present')).toBe('present');
    });
    it('returns undefined for empty / whitespace bounds', () => {
      expect(formatRange('', '  ')).toBeUndefined();
      expect(formatRange(undefined, undefined)).toBeUndefined();
    });
  });

  describe('splitRange', () => {
    it.each([
      ['2018–2022', '2018', '2022'],
      ['2018—2022', '2018', '2022'],
      ['2018~2022', '2018', '2022'],
      ['2018 到 2022', '2018', '2022'],
      ['2018 至 2022', '2018', '2022'],
    ])('splits range %j', (text, start, end) => {
      expect(splitRange(text)).toEqual({ start, end });
    });
    it('splits a hyphen only when both sides contain a 4-digit year', () => {
      expect(splitRange('2018-2022')).toEqual({ start: '2018', end: '2022' });
      expect(splitRange('2018年9月-2022年6月')).toEqual({ start: '2018年9月', end: '2022年6月' });
    });
    it('does not split a single ISO-ish date on its hyphen', () => {
      expect(splitRange('2018-09')).toEqual({ start: '2018-09' });
      expect(splitRange('2022-06')).toEqual({ start: '2022-06' });
    });
    it('keeps “至今” together (the 至 in 至今 is not a separator)', () => {
      expect(splitRange('2018至今')).toEqual({ start: '2018至今' });
    });
    it('puts a separator-free value into start without dropping characters', () => {
      expect(splitRange('2022')).toEqual({ start: '2022' });
      expect(splitRange('   ')).toEqual({});
    });
  });

  describe('sanitizeLocalProfile', () => {
    it('trims scalars and drops blank rows / empty arrays', () => {
      const out = sanitizeLocalProfile({
        fullName: '  Al  ',
        email: '',
        education: [{ school: '   ', degree: 'BS' }, { school: 'ZJU', degree: '  ' }],
        workHistory: [{ company: '', role: 'SDE' }],
      });
      expect(out.fullName).toBe('Al');
      expect(out.email).toBeUndefined();
      expect(out.education).toEqual([{ school: 'ZJU', degree: undefined, start: undefined, end: undefined }]);
      expect(out.workHistory).toBeUndefined();
    });
  });

  describe('localProfileToResumeFields', () => {
    const full: LocalProfileFields = {
      fullName: 'Al',
      email: 'a@x.dev',
      phone: '123',
      location: 'Remote',
      personalSite: 'https://al.dev',
      linkedinUrl: 'https://linkedin.com/in/al',
      education: [{ school: 'ZJU', degree: 'BS', start: '2018-09', end: '2022-06' }],
      workHistory: [
        { company: 'ACME', role: 'SDE', start: '2022-07', end: 'present', detail: 'Shipped X' },
        { company: 'NoRole', start: '2020', end: '2021' },
      ],
    };

    it('projects every resume field and derives period from start/end', () => {
      const r = localProfileToResumeFields(full);
      expect(r).toMatchObject({
        fullName: 'Al',
        email: 'a@x.dev',
        phone: '123',
        location: 'Remote',
        personalSite: 'https://al.dev',
      });
      expect(r.education).toEqual([{ school: 'ZJU', degree: 'BS', period: '2018-09 – 2022-06' }]);
      expect(r.workHistory).toEqual([
        { company: 'ACME', role: 'SDE', period: '2022-07 – present', detail: 'Shipped X' },
      ]);
    });

    it('prefers personalSite but falls back to linkedinUrl', () => {
      expect(localProfileToResumeFields({ linkedinUrl: 'https://linkedin.com/in/b' }).personalSite).toBe(
        'https://linkedin.com/in/b',
      );
    });

    it('filters out education without a degree and work without a role (no fabrication)', () => {
      const r = localProfileToResumeFields({
        education: [{ school: 'OnlySchool' }],
        workHistory: [{ company: 'OnlyCompany' }],
      });
      expect(r.education).toBeUndefined();
      expect(r.workHistory).toBeUndefined();
    });

    it('returns an empty object for an empty profile', () => {
      expect(localProfileToResumeFields({})).toEqual({});
    });
  });

  describe('localProfileToAtsFields', () => {
    it('maps role to title and drops fields ATS has no slot for', () => {
      const ats = localProfileToAtsFields({
        fullName: 'Al',
        personalSite: 'https://al.dev',
        linkedinUrl: 'https://linkedin.com/in/al',
        education: [{ school: 'ZJU', degree: 'BS', start: '2018', end: '2022' }],
        workHistory: [{ company: 'ACME', role: 'SDE', start: '2022', end: 'present', detail: 'n/a' }],
      });
      expect(ats).toEqual({
        linkedinUrl: 'https://linkedin.com/in/al',
        education: [{ school: 'ZJU', degree: 'BS', start: '2018', end: '2022' }],
        experience: [{ company: 'ACME', title: 'SDE', start: '2022', end: 'present' }],
      });
      expect(ats).not.toHaveProperty('fullName');
      expect(ats).not.toHaveProperty('personalSite');
    });
  });

  describe('legacy migration', () => {
    it('converts legacy resume fields, splitting free-text period and keeping detail', () => {
      const c = legacyResumeToLocalProfile({
        fullName: 'Al',
        personalSite: 'https://al.dev',
        education: [{ school: 'ZJU', degree: 'BS', period: '2018–2022' }],
        workHistory: [{ company: 'ACME', role: 'SDE', period: '2022 - present', detail: 'X' }],
      });
      expect(c.education?.[0]).toMatchObject({ school: 'ZJU', degree: 'BS', start: '2018', end: '2022' });
      expect(c.workHistory?.[0]).toMatchObject({ company: 'ACME', role: 'SDE', detail: 'X' });
    });

    it('converts legacy ATS fields, mapping experience.title to workHistory.role', () => {
      const c = legacyAtsToLocalProfile({
        linkedinUrl: 'https://linkedin.com/in/a',
        education: [{ school: 'ZJU', degree: 'BS' }],
        experience: [{ company: 'ACME', title: 'SDE', start: '2022', end: 'present' }],
      });
      expect(c.linkedinUrl).toBe('https://linkedin.com/in/a');
      expect(c.workHistory).toEqual([{ company: 'ACME', role: 'SDE', start: '2022', end: 'present' }]);
    });

    it('round-trips canonical → ATS → canonical without losing structured dates', () => {
      const original: LocalProfileFields = {
        linkedinUrl: 'https://linkedin.com/in/a',
        education: [{ school: 'ZJU', degree: 'BS', start: '2018', end: '2022' }],
        workHistory: [{ company: 'ACME', role: 'SDE', start: '2022', end: 'present' }],
      };
      expect(legacyAtsToLocalProfile(localProfileToAtsFields(original))).toEqual({
        linkedinUrl: 'https://linkedin.com/in/a',
        education: [{ school: 'ZJU', degree: 'BS', start: '2018', end: '2022' }],
        workHistory: [{ company: 'ACME', role: 'SDE', start: '2022', end: 'present' }],
      });
    });
  });

  describe('mergeLocalProfile', () => {
    it('takes the first non-empty scalar and concatenates + dedupes rows', () => {
      const merged = mergeLocalProfile(
        { email: 'a@x.dev', education: [{ school: 'ZJU', degree: 'BS' }] },
        {
          email: 'ignored@x.dev',
          phone: '123',
          education: [{ school: 'ZJU', degree: 'BS' }, { school: 'MIT', degree: 'MS' }],
          workHistory: [{ company: 'ACME', role: 'SDE' }, { company: 'ACME', role: 'SDE' }],
        },
        null,
        undefined,
      );
      expect(merged.email).toBe('a@x.dev');
      expect(merged.phone).toBe('123');
      expect(merged.education).toHaveLength(2);
      expect(merged.workHistory).toEqual([{ company: 'ACME', role: 'SDE' }]);
    });
  });
});
