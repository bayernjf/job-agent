import type { JobSource } from '@jobagent/shared';
import type { JobSourceAdapter } from './types.js';
import { RemoteOkAdapter } from './remoteok.js';
import { RemotiveAdapter } from './remotive.js';
import { GreenhouseAdapter, type GreenhouseBoard } from './greenhouse.js';
import { LeverAdapter, type LeverBoard } from './lever.js';
import { HnWhoIsHiringAdapter, type HnAdapterOptions } from './hn-whoishiring.js';

/**
 * Greenhouse 种子 board 清单（token = job-boards.greenhouse.io/{token}）。
 * 初始仅纳入已验证可用的高置信样例；扩充时直接追加，单个 board 404 会被自动跳过。
 */
export const SEED_GREENHOUSE_BOARDS: GreenhouseBoard[] = [
  { token: 'airtable', companyName: 'Airtable' },
  { token: 'stripe', companyName: 'Stripe' },
  { token: 'figma', companyName: 'Figma' },
  { token: 'discord', companyName: 'Discord' },
  { token: 'gitlab', companyName: 'GitLab' },
  { token: 'cloudflare', companyName: 'Cloudflare' },
  { token: 'datadog', companyName: 'Datadog' },
  { token: 'dropbox', companyName: 'Dropbox' },
];

/**
 * Lever 种子 board 清单（slug = jobs.lever.co/{slug}，posting 本身不含公司名）。
 * 每个 slug 均于 2026-09-13 实测 api.lever.co 返回 200 且当前有在招工程岗；
 * 扩充时先实测可达性再追加（单个 board 404 会被自动跳过）。
 */
export const SEED_LEVER_BOARDS: LeverBoard[] = [
  { slug: 'alluxio', companyName: 'Alluxio' },
  { slug: 'binance', companyName: 'Binance' },
  { slug: 'palantir', companyName: 'Palantir' },
  { slug: 'scaleway', companyName: 'Scaleway' },
  { slug: 'shieldai', companyName: 'Shield AI' },
  { slug: 'sonarsource', companyName: 'SonarSource' },
  { slug: 'spotify', companyName: 'Spotify' },
  { slug: 'sysdig', companyName: 'Sysdig' },
  { slug: 'zoox', companyName: 'Zoox' },
];

export const DEFAULT_SOURCES: JobSource[] = ['remoteok', 'remotive', 'greenhouse', 'lever'];

export interface DefaultAdapterOptions {
  /** 只启用指定源，默认四源全启 */
  sources?: JobSource[];
  greenhouseBoards?: GreenhouseBoard[];
  leverBoards?: LeverBoard[];
  /** HN 月度源选项（仅当 sources 显式含 hn_whoishiring 时挂载，默认日更不含它） */
  hn?: HnAdapterOptions;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  logger?: Pick<Console, 'warn'>;
}

/** 构造默认适配器集合（源顺序即采集顺序：整站 API 优先，多 board 源在后）。 */
export function createDefaultAdapters(options: DefaultAdapterOptions = {}): JobSourceAdapter[] {
  const enabled = new Set(options.sources ?? DEFAULT_SOURCES);
  const adapters: JobSourceAdapter[] = [];

  if (enabled.has('remoteok')) adapters.push(new RemoteOkAdapter());
  if (enabled.has('remotive')) adapters.push(new RemotiveAdapter());
  if (enabled.has('greenhouse')) {
    adapters.push(
      new GreenhouseAdapter({
        boards: options.greenhouseBoards ?? SEED_GREENHOUSE_BOARDS,
        sleep: options.sleep,
        intervalMs: options.intervalMs,
        logger: options.logger,
      }),
    );
  }
  if (enabled.has('lever')) {
    adapters.push(
      new LeverAdapter({
        boards: options.leverBoards ?? SEED_LEVER_BOARDS,
        sleep: options.sleep,
        intervalMs: options.intervalMs,
        logger: options.logger,
      }),
    );
  }
  // HN 为月度自由文本源：默认日更集合不含，仅在显式启用时挂载（每月单独跑一次）
  if (enabled.has('hn_whoishiring')) {
    adapters.push(new HnWhoIsHiringAdapter(options.hn));
  }
  return adapters;
}
