/**
 * 判定规则的守护（原因是这是产品的立身之本）。
 *
 * 优先级最高的两条不是"正常路径跑通"，而是 **HARD RULE 的反面**：
 * - 摘掉证据 → `supportable` 必须转红。防的是"恒判 supportable 的绿灯"，那是本功能
 *   唯一的、也是最致命的失效模式——它把核验变成一块永远点头的招牌。
 * - 抽象能力声明永远落到 `insufficient_data`，**绝不**落到 `no_trace`。
 * 另外 §8 的"画像快照逐字节不变"也钉在这里。
 */
import { describe, it, expect } from 'vitest';
import { assessClaim, SUPPORTABLE_MIN_EVIDENCE } from './rules.js';
import { CLAIM_RULE_VERSION } from './version.js';
import type { ClaimEvidence, ClaimInput, ClaimProfileFacts } from './types.js';

const evidence: ClaimEvidence[] = [
  {
    evidenceId: 'ev-1',
    url: 'https://github.com/acme/web/commit/aaa111',
    rawRef: 'aaa111',
    sourceType: 'commit',
    claim: 'Refactored the web client in TypeScript',
  },
  {
    evidenceId: 'ev-2',
    url: 'https://github.com/acme/web/pull/42',
    rawRef: '42',
    sourceType: 'pr',
    claim: 'TypeScript strict migration across the codebase',
  },
  {
    evidenceId: 'ev-3',
    url: 'https://github.com/acme/web/commit/bbb222',
    rawRef: 'bbb222',
    sourceType: 'commit',
    claim: 'Rebuilt the dashboard with React hooks',
  },
  {
    evidenceId: 'ev-4',
    url: 'https://github.com/acme/api/pull/9',
    rawRef: '9',
    sourceType: 'pr',
    claim: 'Introduced PostgreSQL read replicas',
  },
];

const profile: ClaimProfileFacts = {
  skillTags: [
    { name: 'TypeScript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: ['ev-1', 'ev-2'] },
    { name: 'React', kind: 'framework', depth: 'used', confidence: 0.6, evidenceRefs: ['ev-3'] },
    { name: 'PostgreSQL', kind: 'domain', depth: 'used', confidence: 0.7, evidenceRefs: ['ev-4'] },
  ],
};

const input = (text: string, id = 'claim-1'): ClaimInput => ({ id, text, source: 'manual' });

describe('assessClaim', () => {
  it('supports a claim whose technologies are backed by enough evidence', () => {
    const result = assessClaim({ claim: input('I write TypeScript every day'), profile, evidence });
    expect(result.verdict).toBe('supportable');
    expect(result.code).toBe('token_skill_tag');
    expect(result.confidence).toBe(1);
    expect(result.evidenceIds.sort()).toEqual(['ev-1', 'ev-2']);
    expect(result.facts.tokens).toEqual(['TypeScript']);
    expect(result.ruleVersion).toBe(CLAIM_RULE_VERSION);
  });

  it('downgrades to partial when only one evidence item carries the word', () => {
    const result = assessClaim({ claim: input('Built dashboards in React'), profile, evidence });
    expect(result.verdict).toBe('partial');
    expect(result.code).toBe('token_weak_support');
    expect(result.evidenceIds).toEqual(['ev-3']);
    expect(result.confidence).toBeCloseTo(1 / SUPPORTABLE_MIN_EVIDENCE);
  });

  it('reports no_trace only for a checkable technology that truly leaves no trace', () => {
    // Kubernetes 在词典里＝可核验；画像证据列表非空＝确实查过了；一条都没对上＝no_trace。
    const result = assessClaim({ claim: input('Ran production workloads on Kubernetes'), profile, evidence });
    expect(result.verdict).toBe('no_trace');
    expect(result.code).toBe('no_matching_evidence');
    expect(result.evidenceIds).toEqual([]);
    expect(result.confidence).toBeNull();
  });

  it('never turns an unverifiable soft-skill claim into no_trace', () => {
    // 这条是本功能最重要的一条断言："沟通能力强" 不是造假，是核验不了。
    const result = assessClaim({
      claim: input('Excellent communication skills and strong ownership'),
      profile,
      evidence,
    });
    expect(result.verdict).toBe('insufficient_data');
    expect(result.code).toBe('no_checkable_token');
    expect(result.confidence).toBeNull();
    expect(result.evidenceIds).toEqual([]);
  });

  it('reports insufficient_data rather than no_trace when there is no evidence to look at', () => {
    // 证据列表为空＝压根没查过。此时说 no_trace 是在编造结论。
    const result = assessClaim({ claim: input('Deep PostgreSQL experience'), profile, evidence: [] });
    expect(result.verdict).toBe('insufficient_data');
    expect(result.evidenceIds).toEqual([]);
  });

  it('accepts an explicit artefact pointer written as a full URL', () => {
    const result = assessClaim({
      claim: input('Led the migration at https://github.com/acme/web/pull/42'),
      profile,
      evidence,
    });
    expect(result.verdict).toBe('supportable');
    expect(result.code).toBe('explicit_ref_hit');
    expect(result.evidenceIds).toEqual(['ev-2']);
    expect(result.facts.explicitRefs).toHaveLength(1);
  });

  it('refuses to treat a bare PR number as proof, since the repo is unknown', () => {
    // "PR #42" 没带仓库，碰巧同名数字会撞到别人的仓库，所以不当显式指针。
    const result = assessClaim({ claim: input('Merged PR #42 into main'), profile, evidence });
    expect(result.facts.explicitRefs).toEqual([]);
    expect(result.verdict).toBe('insufficient_data');
  });

  it('turns red once the evidence lookup is taken away (§8 反证)', () => {
    // 防"恒判 supportable"：同一句话，把证据抽走必须不再是 supportable。
    const claim = input('I write TypeScript every day');
    expect(assessClaim({ claim, profile, evidence }).verdict).toBe('supportable');
    const starved = assessClaim({ claim, profile, evidence: [] });
    expect(starved.verdict).not.toBe('supportable');
    expect(starved.evidenceIds).toEqual([]);

    // 换一种摘法：保留证据行但让画像标签指向不存在的 ref，同样不许是 supportable。
    const liar = assessClaim({
      claim,
      profile: {
        skillTags: [
          { name: 'TypeScript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: ['ghost-1', 'ghost-2'] },
        ],
      },
      evidence: evidence.map((e) => ({ ...e, claim: 'Unrelated housekeeping' })),
    });
    expect(liar.verdict).not.toBe('supportable');
  });

  it('never invents an evidence id that was not supplied', () => {
    const supplied = new Set(evidence.map((e) => e.evidenceId));
    for (const text of [
      'I write TypeScript every day',
      'Built dashboards in React',
      'Led it at https://github.com/acme/web/pull/42',
      'Ran production workloads on Kubernetes',
    ]) {
      const result = assessClaim({ claim: input(text), profile, evidence });
      for (const id of result.evidenceIds) expect(supplied.has(id)).toBe(true);
    }
  });

  it('leaves the profile snapshot byte-identical (§8 验收 4)', () => {
    const snapshot = structuredClone(profile);
    assessClaim({ claim: input('I write TypeScript every day'), profile, evidence });
    expect(JSON.stringify(profile)).toBe(JSON.stringify(snapshot));
  });
});
