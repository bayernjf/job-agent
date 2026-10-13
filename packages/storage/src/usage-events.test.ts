import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { RecordUsageInput } from '@jobagent/shared';
import type { UsageEventRecord } from './entities/usage-event.js';
import type { IUsageEventsRepository } from './repositories/usage-events.js';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteUsageEventsRepository } from './sqlite/usage-events-repo.js';
import { createNullUsageRecorder, createUsageRecorder } from './usage-recorder.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function fresh() {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return {
    repo: new SqliteUsageEventsRepository(db),
    close: () => client.close(),
  };
}

/** 造一条完整事件行：除给出的字段外全部归 null（与 recorder 的归一行为一致）。 */
function ev(
  partial: Pick<UsageEventRecord, 'id' | 'category' | 'feature' | 'billingSource' | 'createdAt'> &
    Partial<UsageEventRecord>,
): UsageEventRecord {
  return {
    accountId: null,
    provider: null,
    model: null,
    promptTokens: null,
    completionTokens: null,
    quantity: null,
    ...partial,
  };
}

// 固定夹具：跨两个自然日、三类 category、含 null token/quantity 与匿名（accountId null）事件。
const E1 = ev({
  id: 'usg-e1',
  accountId: 'acc-1',
  category: 'llm',
  feature: 'cover_letter',
  billingSource: 'builtin',
  provider: 'openai-compatible',
  model: 'gpt-x',
  promptTokens: 100,
  completionTokens: 50,
  createdAt: '2026-10-13T23:30:00.000Z',
});
const E2 = ev({
  id: 'usg-e2',
  accountId: 'acc-1',
  category: 'llm',
  feature: 'cover_letter',
  billingSource: 'byok',
  promptTokens: 200,
  completionTokens: 80,
  createdAt: '2026-10-14T00:30:00.000Z',
});
const E3 = ev({
  id: 'usg-e3',
  accountId: 'acc-2',
  category: 'llm',
  feature: 'resume_polish',
  billingSource: 'builtin',
  promptTokens: 300,
  createdAt: '2026-10-14T01:00:00.000Z',
});
const E4 = ev({
  id: 'usg-e4',
  category: 'search',
  feature: 'websearch',
  billingSource: 'platform',
  provider: 'tavily',
  quantity: 3,
  createdAt: '2026-10-14T02:00:00.000Z',
});
// 窗口外对照：恰好落在 until 边界上（until 不含）。
const E5 = ev({
  id: 'usg-e5',
  accountId: 'acc-1',
  category: 'analysis',
  feature: 'analysis_job',
  billingSource: 'platform',
  quantity: 2,
  createdAt: '2026-10-15T00:00:00.000Z',
});

async function seed(repo: IUsageEventsRepository): Promise<void> {
  for (const e of [E1, E2, E3, E4, E5]) await repo.insert(e);
}

const SINCE = '2026-10-13T00:00:00.000Z';
const UNTIL = '2026-10-15T00:00:00.000Z';

describe('SqliteUsageEventsRepository', () => {
  it('aggregates by category/feature/billingSource with COALESCE sums in deterministic order', async () => {
    const s = fresh();
    try {
      await seed(s.repo);
      const rows = await s.repo.summarize({ sinceIso: SINCE, untilIso: UNTIL });
      // E5 恰好等于 until（不含）被排除；其余 4 条各自成组。
      expect(rows).toEqual([
        { category: 'llm', feature: 'cover_letter', billingSource: 'builtin', events: 1, sumPromptTokens: 100, sumCompletionTokens: 50, sumQuantity: 0 },
        { category: 'llm', feature: 'cover_letter', billingSource: 'byok', events: 1, sumPromptTokens: 200, sumCompletionTokens: 80, sumQuantity: 0 },
        // E3 completionTokens 为 null → COALESCE 兜底 0，绝不冒 null。
        { category: 'llm', feature: 'resume_polish', billingSource: 'builtin', events: 1, sumPromptTokens: 300, sumCompletionTokens: 0, sumQuantity: 0 },
        // 非 LLM 事件 token 全 null、只记 quantity。
        { category: 'search', feature: 'websearch', billingSource: 'platform', events: 1, sumPromptTokens: 0, sumCompletionTokens: 0, sumQuantity: 3 },
      ]);
    } finally {
      s.close();
    }
  });

  it('treats since as inclusive and until as exclusive; omitted until reads to the latest', async () => {
    const s = fresh();
    try {
      await seed(s.repo);
      // since 恰好等于 E2 之后的时刻：E1 被切掉（含 E2 起）。
      const tail = await s.repo.summarize({ sinceIso: '2026-10-14T00:00:00.000Z' });
      expect(tail.map((r) => [r.category, r.feature, r.billingSource])).toEqual([
        ['analysis', 'analysis_job', 'platform'],
        ['llm', 'cover_letter', 'byok'],
        ['llm', 'resume_polish', 'builtin'],
        ['search', 'websearch', 'platform'],
      ]);
      // 同一窗口补 until（含边界语义）：E5 再次出局。
      const bounded = await s.repo.summarize({ sinceIso: '2026-10-14T00:00:00.000Z', untilIso: UNTIL });
      expect(bounded).toHaveLength(3);
      expect(bounded.some((r) => r.category === 'analysis')).toBe(false);
    } finally {
      s.close();
    }
  });

  it('filters by accountId and category; anonymous rows never match an account filter', async () => {
    const s = fresh();
    try {
      await seed(s.repo);
      const mine = await s.repo.summarize({ sinceIso: SINCE, untilIso: UNTIL, accountId: 'acc-1' });
      expect(mine).toHaveLength(2);
      expect(mine.every((r) => r.category === 'llm')).toBe(true);

      const searches = await s.repo.summarize({ sinceIso: SINCE, untilIso: UNTIL, category: 'search' });
      expect(searches).toEqual([
        { category: 'search', feature: 'websearch', billingSource: 'platform', events: 1, sumPromptTokens: 0, sumCompletionTokens: 0, sumQuantity: 3 },
      ]);

      const nobody = await s.repo.summarize({ sinceIso: SINCE, untilIso: UNTIL, accountId: 'acc-ghost' });
      expect(nobody).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('buckets daily rows by UTC calendar day and category, honoring the same filters', async () => {
    const s = fresh();
    try {
      await seed(s.repo);
      const days = await s.repo.summarizeDaily({ sinceIso: SINCE, untilIso: UNTIL });
      expect(days).toEqual([
        { day: '2026-10-13', category: 'llm', events: 1, sumPromptTokens: 100, sumCompletionTokens: 50, sumQuantity: 0 },
        // E2+E3 合并：prompt 200+300；E3 completion null → 只计 E2 的 80。
        { day: '2026-10-14', category: 'llm', events: 2, sumPromptTokens: 500, sumCompletionTokens: 80, sumQuantity: 0 },
        { day: '2026-10-14', category: 'search', events: 1, sumPromptTokens: 0, sumCompletionTokens: 0, sumQuantity: 3 },
      ]);

      // 过滤口径与 summarize 一致（按 accountId 收敛后只剩本人两天各一行）。
      const mine = await s.repo.summarizeDaily({ sinceIso: SINCE, untilIso: UNTIL, accountId: 'acc-1' });
      expect(mine.map((r) => [r.day, r.category, r.events])).toEqual([
        ['2026-10-13', 'llm', 1],
        ['2026-10-14', 'llm', 1],
      ]);
    } finally {
      s.close();
    }
  });
});

describe('createUsageRecorder', () => {
  function capturingRepo(): IUsageEventsRepository & { rows: UsageEventRecord[] } {
    return {
      rows: [],
      async insert(row) {
        this.rows.push(row);
      },
      async summarize() {
        return [];
      },
      async summarizeDaily() {
        return [];
      },
    };
  }

  const input: RecordUsageInput = {
    accountId: null,
    category: 'search',
    feature: 'websearch',
    billingSource: 'platform',
    quantity: 2,
  };

  it('injects a usg- id and UTC ISO createdAt, normalizing omitted optionals to null', async () => {
    const repo = capturingRepo();
    const recorder = createUsageRecorder(repo);
    await recorder.record(input);

    expect(repo.rows).toHaveLength(1);
    const row = repo.rows[0]!;
    expect(row.id).toMatch(/^usg-[0-9a-f-]{36}$/);
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(row).toMatchObject({
      accountId: null,
      category: 'search',
      feature: 'websearch',
      billingSource: 'platform',
      provider: null,
      model: null,
      promptTokens: null,
      completionTokens: null,
      quantity: 2,
    });
  });

  it('is fail-open: a throwing repository only logs and never rejects', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken: IUsageEventsRepository = {
      async insert() {
        throw new Error('no such table: usage_events');
      },
      async summarize() {
        return [];
      },
      async summarizeDaily() {
        return [];
      },
    };
    try {
      await expect(createUsageRecorder(broken).record(input)).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledOnce();
      expect(String(spy.mock.calls[0]![0])).toContain('[usage]');
      expect(String(spy.mock.calls[0]![1])).toContain('websearch');
    } finally {
      spy.mockRestore();
    }
  });

  it('null recorder accepts anything without side effects', async () => {
    await expect(createNullUsageRecorder().record(input)).resolves.toBeUndefined();
  });
});
