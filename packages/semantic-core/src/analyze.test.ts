import { describe, expect, it } from 'vitest';
import { SEMANTIC_RULE_VERSION, type L3SemanticInput } from '@jobagent/shared';
import { analyzeSemantic } from './index.js';

function makeRepo(
  overrides: Partial<L3SemanticInput['repos'][number]> = {},
): L3SemanticInput['repos'][number] {
  return {
    owner: 'dev-user',
    name: 'alpha',
    defaultBranch: 'main',
    language: 'TypeScript',
    topics: ['ai', 'agent'],
    description: 'An agent framework',
    starred: 120,
    fileTree: [
      'package.json',
      'src/index.ts',
      'src/index.test.ts',
      'tests/smoke.ts',
      '.github/workflows/ci.yml',
      'Dockerfile',
      'LICENSE',
    ],
    readmeExcerpt: '# Alpha\n\nAn agent framework that does things with many words here.' + ' more context.'.repeat(30),
    keyFiles: {
      'package.json': JSON.stringify({
        dependencies: { react: '^18', next: '14', numpy: '^1' },
        devDependencies: { typescript: '^5', vitest: '^2' },
      }),
    },
    missing: [],
    ...overrides,
  } as L3SemanticInput['repos'][number];
}

const input: L3SemanticInput = {
  collectedAt: '2026-10-11T00:00:00.000Z',
  login: 'dev-user',
  repos: [makeRepo()],
};

describe('analyzeSemantic', () => {
  it('emits deterministic rule-versioned signals for a healthy repo', () => {
    const signals = analyzeSemantic(input);
    expect(signals.ruleVersion).toBe(SEMANTIC_RULE_VERSION);
    expect(signals.summary.techStack).toEqual(['nextjs', 'python', 'react', 'typescript', 'vitest']);
    expect(signals.summary.domainHints).toEqual(['ai', 'agent']);
    const repo = signals.repos[0]!;
    expect(repo.maturity).toEqual({
      hasTests: true,
      hasCi: true,
      hasDocs: true,
      hasLicense: true,
      hasDockerfile: true,
      fileCount: 7,
      starBand: 'mid',
    });
    expect(repo.repoKind).toBe('framework');
    expect(repo.missing).toEqual([]);
  });

  it('marks missing inputs as missing instead of zeros', () => {
    const repo = makeRepo({
      starred: 0,
      description: '', // 无描述也无文件树/README → 无依据可判，不得冒充 application/framework
      fileTree: [],
      readmeExcerpt: '',
      keyFiles: {},
      missing: ['tree', 'readme', 'key_files'],
    });
    const signals = analyzeSemantic({ ...input, repos: [repo] });
    const sig = signals.repos[0]!;
    expect(sig.maturity).toEqual({
      hasTests: false,
      hasCi: false,
      hasDocs: false,
      hasLicense: false,
      hasDockerfile: false,
      fileCount: 0,
      starBand: 'none',
    });
    expect(sig.repoKind).toBe('unknown');
    expect(sig.techStack).toEqual([]);
    expect(sig.missing).toEqual(['tree', 'readme', 'key_files']);
  });

  it('classifies repo kinds by description keywords', () => {
    const cases: Array<[string, string]> = [
      ['A boilerplate starter for React apps', 'boilerplate'],
      ['A framework for building agents', 'framework'],
      ['A tiny library for dates', 'library'],
      ['CLI utility for json', 'tool'],
      ['', 'application'], // 有 README/文件树 → application
    ];
    for (const [description, expected] of cases) {
      const repo = makeRepo({
        description,
        readmeExcerpt: description ? '# X\n' + description : '# X\nsome readme body text here',
        fileTree: ['README.md'],
      });
      const signals = analyzeSemantic({ ...input, repos: [repo] });
      expect(signals.repos[0]!.repoKind).toBe(expected);
    }
    // 无 README、无文件树、无描述 → unknown（缺失不冒充 application）
    const empty = analyzeSemantic({
      ...input,
      repos: [makeRepo({ description: '', readmeExcerpt: '', fileTree: [] })],
    });
    expect(empty.repos[0]!.repoKind).toBe('unknown');
  });

  it('parses pyproject/go.mod/Cargo.toml/requirements tech stack', () => {
    const repo = makeRepo({
      fileTree: ['pyproject.toml', 'go.mod', 'Cargo.toml', 'requirements.txt'],
      keyFiles: {
        'pyproject.toml': '[project]\nname = "x"\ndependencies = [\n  "fastapi>=0.100",\n  "pandas>=2",\n]\n',
        'go.mod': 'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n)\n',
        'Cargo.toml': '[dependencies]\nserde = "1.0"\ntokio = { version = "1" }\n',
        'requirements.txt': 'django==5.0\nflask\n',
      },
    });
    const signals = analyzeSemantic({ ...input, repos: [repo] });
    expect(signals.repos[0]!.techStack).toEqual(['django', 'fastapi', 'flask', 'go', 'python', 'rust']);
  });

  it('deduplicates tags across repos and caps summary', () => {
    const repo2 = makeRepo({
      name: 'beta',
      fileTree: ['package.json'],
      keyFiles: {
        'package.json': JSON.stringify({ dependencies: { react: '^19', hono: '^4' } }),
      },
    });
    const signals = analyzeSemantic({ ...input, repos: [input.repos[0]!, repo2] });
    expect(signals.summary.techStack).toContain('react');
    expect(signals.summary.techStack).toContain('hono');
    expect(signals.summary.techStack.filter((t) => t === 'react').length).toBe(1);
  });
});
