/**
 * `jobagent resume ...` 子命令组（岗位定向简历，P-R1）：
 *   resume build --profile <id|file.json> --job <jobId>
 *                [--job-file <posting.json>] [--evidence <file.json>]
 *                [--local-fields <file.json>] [--format md|html|json]
 *                [--locale zh-CN|en] [--highlight-limit n] [-o out]
 *
 * 两种取数路径：
 *   - 库模式：--profile 传本地库 profileId、--job 传 job_postings 主键，证据由 storage.listByProfile 取；
 *   - 离线模式：--profile 传画像 JSON 文件、--job-file 传岗位 JSON，证据可选 --evidence（EvidenceItem 数组）。
 * 匹配在命令内用 matchJobs 现算（不要求用户传匹配结果）；零命中时走 low_match 降级。
 * 纯装配在 @jobagent/resume-core，本文件只做 I/O。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  EvidenceItemSchema,
  LocalResumeFieldsSchema,
  JobPostingSchema,
  parseAbilityProfile,
  type AbilityProfile,
  type EvidenceItem,
  type JobPosting,
  type LocalResumeFields,
  type ResumeLocale,
} from '@jobagent/shared';
import { createStorage, type StorageContext } from '@jobagent/storage';
import { matchJobs } from '@jobagent/job-source';
import { buildResume, renderHtml, renderMarkdown, type ResumeMatchInput } from '@jobagent/resume-core';
import type { CliDeps } from './index.js';

const ZERO_MATCH: ResumeMatchInput = {
  score: 0,
  matchedSkills: [],
  fieldScores: { title: 0, tags: 0, description: 0 },
  skillHits: [],
};

function isExistingFile(p: string): boolean {
  try {
    readFileSync(p, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function readJson(file: string, label: string, logger: Pick<Console, 'error'>): unknown | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    logger.error(`cannot read ${label} file ${file}: ${(err as Error).message}`);
    return null;
  }
}

async function resolveStorage(deps: CliDeps): Promise<StorageContext> {
  if (deps.storage) return deps.storage;
  const sqlitePath = process.env.DB_PATH ?? 'data/job-agent.db';
  mkdirSync(path.dirname(path.resolve(sqlitePath)), { recursive: true });
  return createStorage({ sqlitePath });
}

/** StoredEvidence（DB 行）→ shared EvidenceItem；非法项跳过（正常不应发生） */
function toEvidenceItems(rows: Array<Record<string, unknown>>): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const row of rows) {
    const candidate = {
      evidenceId: row.id,
      sourcePlatform: row.sourcePlatform,
      sourceType: row.sourceType,
      url: row.url,
      occurredAt: row.occurredAt ?? undefined,
      layer: row.layer,
      claim: row.claim,
      rawRef: row.rawRef,
    };
    const parsed = EvidenceItemSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function loadProfile(raw: unknown): AbilityProfile | null {
  // 兼容直接 AbilityProfile，或 { profile: AbilityProfile } / analyze 命令产物 { profile, meta }
  const candidate =
    raw && typeof raw === 'object' && 'profile' in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).profile
      : raw;
  return parseAbilityProfile(candidate);
}

async function runBuild(rest: string[], deps: CliDeps): Promise<number> {
  const logger = deps.logger ?? console;
  const stdout = deps.stdout ?? process.stdout;
  const { values } = parseArgs({
    args: rest,
    options: {
      profile: { type: 'string' },
      job: { type: 'string' },
      'job-file': { type: 'string' },
      evidence: { type: 'string' },
      'local-fields': { type: 'string' },
      format: { type: 'string' },
      locale: { type: 'string' },
      'highlight-limit': { type: 'string' },
      out: { type: 'string', short: 'o' },
    },
  });

  if (!values.profile) {
    logger.error('Usage: jobagent resume build --profile <id|file.json> --job <jobId> [--job-file f] [--evidence f] [--local-fields f] [--format md|html|json] [--locale zh-CN|en] [-o out]');
    return 2;
  }
  const format = values.format ?? 'md';
  if (!['md', 'markdown', 'html', 'json'].includes(format)) {
    logger.error('--format must be one of: md, html, json (default md)');
    return 2;
  }
  const locale: ResumeLocale = values.locale === 'en' ? 'en' : 'zh-CN';
  let highlightLimit = 10;
  if (values['highlight-limit'] !== undefined) {
    highlightLimit = Number(values['highlight-limit']);
    if (!Number.isInteger(highlightLimit) || highlightLimit < 1) {
      logger.error('--highlight-limit must be a positive integer');
      return 2;
    }
  }

  // 1) 画像：文件优先，否则按本地库 profileId
  let profile: AbilityProfile | null = null;
  let storage: StorageContext | undefined;
  if (isExistingFile(values.profile)) {
    const raw = readJson(values.profile, 'profile', logger);
    if (raw === null) return 1;
    profile = loadProfile(raw);
    if (!profile) {
      logger.error(`profile file ${values.profile} is not a valid AbilityProfile`);
      return 1;
    }
  } else {
    storage = await resolveStorage(deps);
    const stored = await storage.profiles.getById(values.profile);
    if (!stored || !stored.snapshot) {
      logger.error(`profile '${values.profile}' not found in local DB (or has no snapshot)`);
      return 1;
    }
    profile = stored.snapshot;
  }

  // 2) 岗位：库模式 --job，离线模式 --job-file
  let posting: JobPosting | null = null;
  if (values['job-file']) {
    const raw = readJson(values['job-file'], 'job', logger);
    if (raw === null) return 1;
    const parsed = JobPostingSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error(`job-file ${values['job-file']} is not a valid JobPosting: ${parsed.error.issues[0]?.message}`);
      return 1;
    }
    posting = parsed.data;
  } else if (values.job) {
    storage = storage ?? (await resolveStorage(deps));
    const row = await storage.jobPostings.getById(values.job);
    if (!row) {
      logger.error(`job posting '${values.job}' not found in local DB (try 'jobagent jobs search')`);
      return 1;
    }
    posting = JobPostingSchema.parse(row);
  } else {
    logger.error('one of --job <jobId> or --job-file <posting.json> is required');
    return 2;
  }

  // 3) 证据：--evidence 文件 / 库模式 listByProfile / 空
  let evidence: EvidenceItem[] = [];
  if (values.evidence) {
    const raw = readJson(values.evidence, 'evidence', logger);
    if (raw === null) return 1;
    const list = EvidenceItemSchema.array().safeParse(raw);
    if (!list.success) {
      logger.error(`evidence file must be an EvidenceItem[]: ${list.error.issues[0]?.message}`);
      return 1;
    }
    evidence = list.data;
  } else if (storage) {
    const rows = (await storage.evidence.listByProfile(profile.profileId)) as unknown as Array<Record<string, unknown>>;
    evidence = toEvidenceItems(rows);
  }

  // 4) 本地补填（可选）
  let local: LocalResumeFields | undefined;
  if (values['local-fields']) {
    const raw = readJson(values['local-fields'], 'local-fields', logger);
    if (raw === null) return 1;
    const parsed = LocalResumeFieldsSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error(`local-fields invalid: ${parsed.error.issues[0]?.message}`);
      return 1;
    }
    local = parsed.data;
  }

  // 5) 匹配现算（单个岗位）；零命中给零匹配走 low_match 降级
  const skills = profile.skillTags.map((s) => s.name);
  const matched = matchJobs([posting], { skills });
  const match: ResumeMatchInput = matched[0]
    ? {
        score: matched[0].score,
        matchedSkills: matched[0].matchedSkills,
        fieldScores: matched[0].fieldScores,
        skillHits: matched[0].skillHits,
      }
    : ZERO_MATCH;

  // 6) 装配 + 渲染（纯函数）
  const draft = buildResume({
    profile,
    evidence,
    posting,
    match,
    local,
    options: { locale, highlightLimit, now: deps.now?.() },
  });
  const content =
    format === 'json' ? `${JSON.stringify(draft, null, 2)}\n` : format === 'html' ? renderHtml(draft, locale) : `${renderMarkdown(draft, locale)}\n`;

  if (values.out) {
    mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    writeFileSync(values.out, content, 'utf8');
    logger.log(`Wrote ${values.out} (tier=${draft.targetJob.tier}, score=${draft.targetJob.matchScore})`);
  } else {
    stdout.write(content);
  }
  return 0;
}

/** resume 子命令入口，返回进程退出码。 */
export async function runResume(rest: string[], deps: CliDeps): Promise<number> {
  const [sub, ...subRest] = rest;
  try {
    if (sub === 'build') return await runBuild(subRest, deps);
    (deps.logger ?? console).error('Usage: jobagent resume build --profile <id|file> --job <jobId> [--job-file f] [--format md|html|json] [-o out]');
    return 2;
  } catch (err) {
    (deps.logger ?? console).error(`resume ${sub ?? ''} failed: ${(err as Error).message}`);
    return 1;
  }
}
