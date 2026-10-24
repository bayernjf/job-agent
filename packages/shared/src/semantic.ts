/**
 * L3 语义层契约（从 index.ts 拆出，审查动作 #8；设计见
 * docs/design-semantic-layer-20261011.md）。
 * 只采集公开数据、不 clone；L3-A 规则版信号纯 code + facts，不写自然语言。
 */
import { z } from 'zod';

/* L3 语义层契约（2026-10-11，设计见 docs/design-semantic-layer-20261011.md） */
/* 只采集公开数据、不 clone；L3-A 规则版信号纯 code + facts，不写自然语言。 */
/* ========================================================================== */

/** 技术栈标签白名单（与技能提取共用口径的兼容子集）：依赖清单关键词 → 标签 */
export const L3_TECHSTACK_DICTIONARY: Record<string, string> = {
  // JS/TS 生态
  react: 'react',
  'react-dom': 'react',
  next: 'nextjs',
  vue: 'vue',
  nuxt: 'nuxt',
  svelte: 'svelte',
  angular: 'angular',
  typescript: 'typescript',
  'type-safe': 'typescript',
  node: 'nodejs',
  express: 'express',
  fastify: 'fastify',
  hono: 'hono',
  nestjs: 'nestjs',
  electron: 'electron',
  tailwindcss: 'tailwind',
  'tailwind': 'tailwind',
  jest: 'jest',
  vitest: 'vitest',
  playwright: 'playwright',
  eslint: 'eslint',
  prettier: 'prettier',
  prisma: 'prisma',
  drizzle: 'drizzle',
  'graphql': 'graphql',
  apollo: 'graphql',
  redux: 'redux',
  zustand: 'zustand',
  'webpack': 'webpack',
  vite: 'vite',
  esbuild: 'esbuild',
  rollup: 'rollup',
  // Python 生态
  django: 'django',
  flask: 'flask',
  fastapi: 'fastapi',
  numpy: 'python',
  pandas: 'python',
  scipy: 'python',
  'scikit-learn': 'python-ml',
  torch: 'pytorch',
  tensorflow: 'tensorflow',
  transformers: 'transformers',
  pytest: 'pytest',
  celery: 'celery',
  sqlalchemy: 'sqlalchemy',
  // Go / Rust / 系统
  'github.com': 'go',
  serde: 'rust',
  tokio: 'rust',
  clap: 'rust',
  axum: 'rust',
  rocket: 'rust',
  // 基础设施
  docker: 'docker',
  kubernetes: 'kubernetes',
  terraform: 'terraform',
  ansible: 'ansible',
  prometheus: 'prometheus',
  'grafana': 'grafana',
  postgres: 'postgresql',
  redis: 'redis',
  kafka: 'kafka',
};

/** 领域提示关键词白名单（repo topics / description 命中才输出） */
export const L3_DOMAIN_HINTS: string[] = [
  'ai',
  'machine-learning',
  'ml',
  'llm',
  'agent',
  'nlp',
  'computer-vision',
  'data',
  'database',
  'backend',
  'frontend',
  'fullstack',
  'devops',
  'infrastructure',
  'security',
  'blockchain',
  'web3',
  'mobile',
  'embedded',
  'game',
  'ecommerce',
  'saas',
  'opensource',
];

/** L3 规则版本：独立于 analyzer 的 RULE_VERSION；变更必须升本常量并钉字面量测试 */
export const SEMANTIC_RULE_VERSION = '0.1';

/** 单仓库语义采集的降级缺失标记 */
export const L3_MISSING_KEYS = ['tree', 'readme', 'key_files', 'repo_not_found'] as const;
export type L3MissingKey = (typeof L3_MISSING_KEYS)[number];

/** L3 语义层输入：采集器产出（公开数据，不 clone；文件内容只保留截断节选） */
export interface L3SemanticInput {
  collectedAt: string;
  /** 主体（GitHub login） */
  login: string;
  repos: L3RepoFiles[];
}

export interface L3RepoFiles {
  owner: string;
  name: string;
  defaultBranch: string;
  /** repo 主语言（与 L0 口径一致） */
  language: string | null;
  /** repo topics（与 L0 口径一致） */
  topics: string[];
  description: string | null;
  /** star 数 */
  starred: number;
  /** 递归文件树路径（截断），不存内容 */
  fileTree: string[];
  /** README 纯文本节选（截断 ≤16KB），缺失为空串 */
  readmeExcerpt: string;
  /** 白名单关键文件内容（每个 ≤16KB；缺失的键不存在） */
  keyFiles: Record<string, string>;
  /** 本仓库显式缺失标注（缺失不得当作"没有"） */
  missing: L3MissingKey[];
}

/** L3 语义层输出：规则版信号（纯 code + facts，句子由渲染侧按 locale 现拼）。
 * Zod schema 是单一事实源（同时供 AbilityProfileSchema.semantic 可选节校验）。 */
export const L3SignalsSchema = z.object({
  ruleVersion: z.string().min(1),
  repos: z.array(
    z.object({
      owner: z.string().min(1),
      name: z.string().min(1),
      maturity: z.object({
        hasTests: z.boolean(),
        hasCi: z.boolean(),
        hasDocs: z.boolean(),
        hasLicense: z.boolean(),
        hasDockerfile: z.boolean(),
        fileCount: z.number().int().nonnegative(),
        starBand: z.enum(['none', 'low', 'mid', 'high']),
      }),
      techStack: z.array(z.string().min(1)).max(20),
      repoKind: z.enum(['library', 'framework', 'tool', 'application', 'boilerplate', 'unknown']),
      domainHints: z.array(z.string().min(1)).max(10),
      /** 本仓库缺失标注（透传采集侧） */
      missing: z.array(z.enum(L3_MISSING_KEYS)),
    }),
  ),
  summary: z.object({
    /** 跨仓库归并的技术栈标签（去重，≤20） */
    techStack: z.array(z.string().min(1)).max(20),
    /** 领域提示标签（去重，≤10） */
    domainHints: z.array(z.string().min(1)).max(10),
  }),
  /** L3-B：LLM 语义摘要（数据层原文，渲染侧按 locale 展示；规则版缺省） */
  llmSummary: z
    .object({
      repoSummary: z.string().min(1),
      designDecisions: z.array(z.string().min(1)).max(6),
      provider: z.string().min(1),
      model: z.string().min(1),
    })
    .optional(),
});
export type L3Signals = z.infer<typeof L3SignalsSchema>;
/** 单仓库语义信号（由 L3SignalsSchema.repos 元素派生） */
export type L3RepoSignal = L3Signals['repos'][number];
