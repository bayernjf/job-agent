/**
 * 技能技术词典（B-4 精确提取，2026-09-15；设计 docs/design-skill-extraction-20260915.md）。
 * 单一事实源：扩充招聘高频技术栈只改本文件。kind 仍只用 shared 的 framework|domain，
 * 不新增类别（数据库/工具/云等"具体技术"归 framework，领域大类归 domain）。
 * 刻意不放 TypeScript/Python/Go 等已由 repo.primaryLanguage 覆盖的语言，避免与 language 标签重复。
 */

export type CatalogKind = 'framework' | 'domain';

export interface SkillEntry {
  /** 输出标签规范名（小写） */
  name: string;
  /** 命中别名（全部小写，name 自身也应列入）；自由文本按词边界匹配，topics 按精确相等匹配 */
  aliases: string[];
  kind: CatalogKind;
}

/** 具体技术栈（可直接匹配招聘岗位要求） */
const FRAMEWORK_CATALOG: SkillEntry[] = [
  // 前端框架 / 库 / 构建测试
  { name: 'react', aliases: ['react', 'reactjs'], kind: 'framework' },
  { name: 'vue', aliases: ['vue', 'vuejs'], kind: 'framework' },
  { name: 'angular', aliases: ['angular', 'angularjs'], kind: 'framework' },
  { name: 'svelte', aliases: ['svelte', 'sveltekit'], kind: 'framework' },
  { name: 'next.js', aliases: ['next.js', 'nextjs', 'next js'], kind: 'framework' },
  { name: 'nuxt', aliases: ['nuxt', 'nuxtjs'], kind: 'framework' },
  { name: 'astro', aliases: ['astro'], kind: 'framework' },
  { name: 'remix', aliases: ['remix', 'remix-run'], kind: 'framework' },
  { name: 'tailwind', aliases: ['tailwind', 'tailwindcss', 'tailwind css'], kind: 'framework' },
  { name: 'vite', aliases: ['vite', 'vitejs'], kind: 'framework' },
  { name: 'webpack', aliases: ['webpack'], kind: 'framework' },
  { name: 'rollup', aliases: ['rollup', 'rollupjs'], kind: 'framework' },
  { name: 'jest', aliases: ['jest'], kind: 'framework' },
  { name: 'vitest', aliases: ['vitest'], kind: 'framework' },
  { name: 'playwright', aliases: ['playwright'], kind: 'framework' },
  { name: 'cypress', aliases: ['cypress'], kind: 'framework' },
  { name: 'redux', aliases: ['redux', 'reduxjs', 'redux toolkit'], kind: 'framework' },
  // 后端框架 / 运行时
  { name: 'node.js', aliases: ['node.js', 'nodejs', 'node js'], kind: 'framework' },
  { name: 'express', aliases: ['express', 'expressjs'], kind: 'framework' },
  { name: 'koa', aliases: ['koa', 'koajs'], kind: 'framework' },
  { name: 'nestjs', aliases: ['nestjs', 'nest.js'], kind: 'framework' },
  { name: 'fastify', aliases: ['fastify'], kind: 'framework' },
  { name: 'hono', aliases: ['hono'], kind: 'framework' },
  { name: 'fastapi', aliases: ['fastapi'], kind: 'framework' },
  { name: 'django', aliases: ['django'], kind: 'framework' },
  { name: 'flask', aliases: ['flask'], kind: 'framework' },
  { name: 'spring', aliases: ['spring', 'spring boot', 'springboot'], kind: 'framework' },
  { name: 'rails', aliases: ['rails', 'ruby on rails'], kind: 'framework' },
  { name: 'gin', aliases: ['gin', 'gin framework', 'golang gin'], kind: 'framework' },
  // 数据库 / 存储 / ORM
  { name: 'postgresql', aliases: ['postgresql', 'postgres', 'pg'], kind: 'framework' },
  { name: 'mysql', aliases: ['mysql'], kind: 'framework' },
  { name: 'sqlite', aliases: ['sqlite'], kind: 'framework' },
  { name: 'redis', aliases: ['redis'], kind: 'framework' },
  { name: 'mongodb', aliases: ['mongodb', 'mongo'], kind: 'framework' },
  { name: 'elasticsearch', aliases: ['elasticsearch', 'elastic search', 'elk'], kind: 'framework' },
  { name: 'kafka', aliases: ['kafka'], kind: 'framework' },
  { name: 'drizzle', aliases: ['drizzle', 'drizzleorm', 'drizzle orm'], kind: 'framework' },
  { name: 'prisma', aliases: ['prisma'], kind: 'framework' },
  { name: 'typeorm', aliases: ['typeorm', 'type orm'], kind: 'framework' },
  // DevOps / 云 / 基础设施
  { name: 'docker', aliases: ['docker'], kind: 'framework' },
  { name: 'kubernetes', aliases: ['kubernetes', 'k8s'], kind: 'framework' },
  { name: 'terraform', aliases: ['terraform'], kind: 'framework' },
  { name: 'aws', aliases: ['aws'], kind: 'framework' },
  { name: 'gcp', aliases: ['gcp', 'google cloud'], kind: 'framework' },
  { name: 'azure', aliases: ['azure'], kind: 'framework' },
  { name: 'github actions', aliases: ['github actions', 'github-actions', 'gh actions'], kind: 'framework' },
  { name: 'nginx', aliases: ['nginx'], kind: 'framework' },
  { name: 'grafana', aliases: ['grafana'], kind: 'framework' },
  { name: 'prometheus', aliases: ['prometheus'], kind: 'framework' },
  // 移动 / 客户端
  { name: 'flutter', aliases: ['flutter'], kind: 'framework' },
  { name: 'react native', aliases: ['react native', 'react-native'], kind: 'framework' },
  { name: 'android', aliases: ['android'], kind: 'framework' },
  { name: 'ios', aliases: ['ios'], kind: 'framework' },
  { name: 'electron', aliases: ['electron'], kind: 'framework' },
  // ── AI / Agent 层（T04，2026-09-25；判断依据见 docs/design-c-side-first-20260925.md §1.1）──
  // 只收歧义足够低的写法。裸 agent / agents / prompt / prompts / eval / gpt / lora / chroma
  // 一律**不做别名**，因为 compileEntryRegex 是词边界匹配、会稳定误伤：
  //   \bagent\b 命中 "user-agent"（前端/HTTP 仓库满地都是），
  //   \beval\b  命中每一次调用 eval() 的 JS/Python 仓库，
  //   \bgpt\b   在基础设施代码里是 GUID Partition Table，
  //   \blora\b  在 IoT 代码里是 LoRaWAN，\bchroma\b 是配色库。
  // 方向与内核一致：宁可漏报（少一个标签），不可误报（画像失去可信度）。
  // topics 走精确相等，故连 hyphen 形态一起列（GitHub 实际 topic 多用 hyphen）。
  {
    name: 'ai agents',
    aliases: [
      'ai agent', 'ai agents', 'ai-agents', 'ai-agent', 'llm agent', 'llm agents', 'llm-agents', 'llms',
      'agent framework', 'agent frameworks', 'agent-development-kit',
      'multi-agent', 'multi agent', 'agentic', 'agentic workflow', 'agentic workflows', 'agentic-workflows',
      'genai', 'generative ai', 'generative-ai',
    ],
    kind: 'framework',
  },
  {
    name: 'rag',
    aliases: ['rag', 'retrieval augmented generation', 'retrieval-augmented-generation', 'rag pipeline', 'rag pipelines'],
    kind: 'framework',
  },
  {
    name: 'prompt engineering',
    aliases: ['prompt engineering', 'prompt-engineering', 'system prompt', 'system prompts', 'prompt template', 'prompt templates', 'prompt injection'],
    kind: 'framework',
  },
  {
    name: 'llm evaluation',
    aliases: ['llm evaluation', 'llm-evaluation', 'llm eval', 'eval harness', 'evaluation harness', 'llm-as-judge', 'llm as a judge', 'evals'],
    kind: 'framework',
  },
  {
    name: 'model context protocol',
    aliases: ['model context protocol', 'mcp', 'mcp server', 'mcp servers', 'mcp-servers', 'mcp client', 'mcp-client', 'mcp-tools', 'modelcontextprotocol'],
    kind: 'framework',
  },
  { name: 'openai', aliases: ['openai', 'openai api', 'openai-api', 'chatgpt', 'gpt-4', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'azure openai'], kind: 'framework' },
  { name: 'anthropic claude', aliases: ['anthropic', 'claude api', 'claude code', 'claude-code', 'anthropic-sdk'], kind: 'framework' },
  { name: 'langchain', aliases: ['langchain', 'langchainjs', 'langchain-js'], kind: 'framework' },
  { name: 'langgraph', aliases: ['langgraph'], kind: 'framework' },
  { name: 'llamaindex', aliases: ['llamaindex', 'llama-index'], kind: 'framework' },
  { name: 'autogen', aliases: ['autogen', 'pyautogen', 'autogen-studio'], kind: 'framework' },
  { name: 'crewai', aliases: ['crewai', 'crew-ai'], kind: 'framework' },
  { name: 'ai sdk', aliases: ['vercel ai sdk', 'ai-sdk', 'pydantic-ai', 'semantic kernel'], kind: 'framework' },
  {
    name: 'vector database',
    aliases: ['vector database', 'vector-database', 'vector search', 'vector-search', 'vector store', 'pgvector', 'pinecone', 'weaviate', 'qdrant', 'milvus', 'chromadb'],
    kind: 'framework',
  },
  { name: 'embeddings', aliases: ['embeddings', 'embedding model', 'embedding models', 'semantic search', 'sentence-transformers', 'sentence transformers'], kind: 'framework' },
  { name: 'fine-tuning', aliases: ['fine-tuning', 'fine tuning', 'finetuning', 'fine-tune', 'finetune', 'qlora', 'peft'], kind: 'framework' },
  { name: 'hugging face', aliases: ['hugging face', 'huggingface', 'hugging-face', 'hf transformers', 'huggingface transformers', 'diffusers'], kind: 'framework' },
  { name: 'llm serving', aliases: ['vllm', 'llama.cpp', 'llama-cpp', 'llamacpp', 'ollama', 'llm serving', 'model serving'], kind: 'framework' },
  { name: 'function calling', aliases: ['function calling', 'function-calling', 'tool calling', 'tool-calling', 'tool-use', 'tool use llm'], kind: 'framework' },
];

/** 领域大类（粗粒度，置信度上限更保守） */
const DOMAIN_CATALOG: SkillEntry[] = [
  { name: 'frontend', aliases: ['frontend', 'front-end', 'front end', 'web app', 'ui', 'landing'], kind: 'domain' },
  { name: 'backend', aliases: ['backend', 'back-end', 'back end', 'server', 'api', 'database'], kind: 'domain' },
  { name: 'data-ml', aliases: ['data', 'machine learning', 'ml', 'llm', 'ai', 'pytorch', 'tensorflow'], kind: 'domain' },
  { name: 'devops', aliases: ['devops', 'sre', 'ci/cd', 'cicd', 'ci-cd'], kind: 'domain' },
  { name: 'mobile', aliases: ['mobile', 'android', 'ios'], kind: 'domain' },
  { name: 'blockchain', aliases: ['blockchain', 'web3', 'ethereum', 'solidity'], kind: 'domain' },
  { name: 'game', aliases: ['game', 'unity', 'unreal'], kind: 'domain' },
];

export const SKILL_CATALOG: SkillEntry[] = [...FRAMEWORK_CATALOG, ...DOMAIN_CATALOG];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 为词条构造自由文本词边界正则（i 不敏感）。别名 escape 后用 \b 包裹，
 * 避免 express 命中 expression、react 命中 reactive 这类子串误匹配。
 */
export function compileEntryRegex(entry: SkillEntry): RegExp {
  const alt = entry.aliases
    .slice()
    .sort((a, b) => b.length - a.length) // 长别名优先，避免短别名截断
    .map(escapeRegExp)
    .join('|');
  return new RegExp(`\\b(?:${alt})\\b`, 'i');
}

/** topics 是平台结构化干净 token：小写精确相等即命中（不走正则） */
export function topicMatchesEntry(topic: string, entry: SkillEntry): boolean {
  const t = topic.toLowerCase();
  return entry.aliases.includes(t);
}
