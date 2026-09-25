import { describe, expect, it } from 'vitest';
import { computeSkillTags } from './skills.js';
import { SKILL_CATALOG } from './skills-catalog.js';
import { buildInput } from './test-input.js';
import type { AnalyzerCommit, AnalyzerInput, AnalyzerPullRequest, AnalyzerRepo } from './input.js';

function expectValidRefs(input: AnalyzerInput, tags: ReturnType<typeof computeSkillTags>): void {
  const known = new Set(input.evidence.map((e) => e.evidenceId));
  for (const tag of tags) {
    expect(tag.evidenceRefs.length).toBeGreaterThan(0);
    for (const ref of tag.evidenceRefs) {
      expect(known.has(ref), `tag ${tag.name} references unknown evidence ${ref}`).toBe(true);
    }
  }
}

function repo(partial: Partial<AnalyzerRepo> & { name: string }): AnalyzerRepo {
  return {
    ownerLogin: 'dev-strong',
    url: `https://github.com/dev-strong/${partial.name}`,
    isFork: false,
    isArchived: false,
    primaryLanguage: null,
    topics: [],
    description: null,
    stargazerCount: 3,
    forkCount: 0,
    pushedAt: '2026-08-01T00:00:00Z',
    createdAt: '2024-01-01T00:00:00Z',
    ...partial,
  };
}

function commit(partial: Partial<AnalyzerCommit> & { messageHeadline: string }): AnalyzerCommit {
  return {
    oid: 'c0ffee0000000000000000000000000000000001',
    committedAt: '2026-07-01T10:00:00Z',
    authorName: 'Dev Strong',
    authorEmail: 'dev.strong@example.com',
    repoName: 'dev-strong/svc',
    ...partial,
  };
}

function pr(partial: Partial<AnalyzerPullRequest> & { title: string }): AnalyzerPullRequest {
  return {
    number: 1,
    url: 'https://github.com/dev-strong/svc/pull/1',
    state: 'MERGED',
    createdAt: '2026-07-02T10:00:00Z',
    mergedAt: '2026-07-03T10:00:00Z',
    repoNameWithOwner: 'dev-strong/svc',
    repoIsFork: false,
    repoOwnerIsSelf: true,
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    ...partial,
  };
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

  it('does not match technologies across word boundaries (express vs expression)', () => {
    const input = buildInput({
      repos: [repo({ name: 'expression-parser', description: 'A reactive expression parser', topics: ['parser'] })],
      commits: [],
      pullRequests: [],
    });
    const frameworks = computeSkillTags(input).filter((t) => t.kind === 'framework').map((t) => t.name);
    expect(frameworks).not.toContain('express');
    expect(frameworks).not.toContain('react');
  });

  it('normalizes aliases into a single canonical tag', () => {
    const input = buildInput({
      repos: [
        repo({ name: 'k8s-deploy', topics: ['kubernetes'], description: 'k8s manifests' }),
        repo({ name: 'pg-store', topics: ['pg'], description: 'postgres driver' }),
      ],
      commits: [],
      pullRequests: [],
    });
    const names = computeSkillTags(input).filter((t) => t.kind === 'framework').map((t) => t.name);
    expect(names.filter((n) => n === 'kubernetes')).toHaveLength(1);
    expect(names.filter((n) => n === 'postgresql')).toHaveLength(1);
    expect(names).not.toContain('k8s');
    expect(names).not.toContain('pg');
  });

  it('extracts a skill from commit/PR titles and attaches behavior evidence', () => {
    const input = buildInput({
      repos: [repo({ name: 'svc', description: 'backend service', topics: ['api'] })],
      commits: [commit({ oid: 'a'.repeat(40), messageHeadline: 'feat: add redis cache layer' })],
      pullRequests: [pr({ number: 9, title: 'integrate redis sessions' })],
    });
    const tags = computeSkillTags(input);
    const redis = tags.find((t) => t.name === 'redis');
    expect(redis).toBeDefined();
    expect(redis?.evidenceRefs.some((r) => r.startsWith('commit:'))).toBe(true);
    expect(redis?.evidenceRefs.some((r) => r.startsWith('pr:'))).toBe(true);
    expectValidRefs(input, tags);
  });

  it('grades proficient for multi-repo hits and used for a single weak hit', () => {
    const twoRepos = buildInput({
      repos: [
        repo({ name: 'a-docker', description: 'docker image' }),
        repo({ name: 'b-docker', description: 'docker compose' }),
      ],
      commits: [],
      pullRequests: [],
    });
    expect(computeSkillTags(twoRepos).find((t) => t.name === 'docker')?.depth).toBe('proficient');

    const oneRepo = buildInput({
      repos: [repo({ name: 'x', description: 'uses docker' })],
      commits: [],
      pullRequests: [],
    });
    expect(computeSkillTags(oneRepo).find((t) => t.name === 'docker')?.depth).toBe('used');
  });

  // ── T04：AI / Agent 层 ───────────────────────────────────────────────────────

  it('represents an AI-agent developer with the technologies they actually work on', () => {
    const input = buildInput({
      repos: [
        repo({
          name: 'agent-runtime',
          description: 'A production LLM agent framework with tool calling and eval harness',
          topics: ['ai-agents', 'mcp', 'llm'],
        }),
        repo({
          name: 'rag-search',
          description: 'Retrieval augmented generation over pgvector with semantic search',
          topics: ['rag', 'vector-database'],
        }),
      ],
      commits: [commit({ messageHeadline: 'feat: stream model context protocol responses' })],
      pullRequests: [pr({ title: 'Add prompt injection guardrail to the tool-use loop' })],
    });
    const tags = computeSkillTags(input);
    const frameworks = tags.filter((t) => t.kind === 'framework').map((t) => t.name);
    expect(frameworks).toContain('ai agents');
    expect(frameworks).toContain('rag');
    expect(frameworks).toContain('model context protocol');
    expect(frameworks).toContain('vector database');
    // 每个新标签都必须挂真证据，且引用得到的是输入里存在的 evidenceId
    expectValidRefs(input, tags);
    for (const name of ['ai agents', 'rag', 'model context protocol', 'vector database']) {
      const tag = tags.find((t) => t.name === name);
      expect(tag?.evidenceRefs.length, name).toBeGreaterThan(0);
    }
  });

  it('does not let the AI layer fire on the ambiguous words it deliberately excluded', () => {
    // 这些仓库在真实画像里满地都是：HTTP/前端解析、eval() 沙箱、磁盘分区、LoRa 无线电、配色库。
    const input = buildInput({
      repos: [
        repo({ name: 'ua-parser', description: 'Fast user-agent and referer parsing for Node' }),
        repo({ name: 'safe-eval', description: 'Sandboxed eval() for plugin authoring' }),
        repo({ name: 'disk-utils', description: 'GPT and MBR partition table reader' }),
        repo({ name: 'lorawan-gw', description: 'LoRa packet forwarder for IoT gateways' }),
        repo({ name: 'palettes', description: 'chroma-based colour scale generation' }),
      ],
      commits: [commit({ messageHeadline: 'fix: retry when the request agent times out' })],
      pullRequests: [pr({ title: 'Cache prompt resolution for the CLI' })],
    });
    const frameworks = computeSkillTags(input)
      .filter((t) => t.kind === 'framework')
      .map((t) => t.name);
    for (const ai of [
      'ai agents',
      'rag',
      'prompt engineering',
      'llm evaluation',
      'model context protocol',
      'openai',
      'vector database',
      'fine-tuning',
      'function calling',
    ]) {
      expect(frameworks, `false positive: ${ai}`).not.toContain(ai);
    }
  });

  it('matches hyphenated GitHub topics that free-text matching would never see', () => {
    // topics 走小写精确相等，所以 GitHub 的真实 topic 拼写必须逐字进别名表；
    // 只加 'agentic workflows' 是匹配不到 topic 'agentic-workflows' 的。
    const input = buildInput({
      repos: [
        repo({ name: 'orchestrator', description: null, topics: ['agentic-workflows', 'modelcontextprotocol'] }),
        repo({ name: 'tools', description: null, topics: ['mcp-servers', 'ai-agents'] }),
      ],
      commits: [],
      pullRequests: [],
    });
    const tags = computeSkillTags(input);
    const frameworks = tags.filter((t) => t.kind === 'framework').map((t) => t.name);
    expect(frameworks).toContain('ai agents');
    expect(frameworks).toContain('model context protocol');
    expectValidRefs(input, tags);
  });

  it('keeps bare ambiguous tokens out of every catalog alias', () => {
    // 钉住 T04 的判断本身：这些词单独作别名一定误伤，只能以复合形态出现。
    // 有人日后图省事把 'agent' 加回去时，这条会红。
    const banned = ['agent', 'agents', 'prompt', 'prompts', 'eval', 'gpt', 'lora', 'chroma', 'sdk'];
    for (const entry of SKILL_CATALOG) {
      for (const alias of entry.aliases) {
        expect(banned, `alias "${alias}" on ${entry.name} is too ambiguous for word-boundary matching`).not.toContain(
          alias,
        );
      }
    }
  });
});
