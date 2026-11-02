/**
 * LLM 模型供给路由（decision #21，design-llm-model-provisioning-20261003 §4）。
 *
 * 两条独立面：
 * - `/admin/llm-catalog`：平台管理员维护内置目录（迁移 024）。凭证永远在 env，
 *   本面只读写目录字段（白名单不变量在 mergeBuiltinCatalog 里强制）。
 * - `/account/llm-config`：登录用户管理自己的 BYOK 配置（迁移 025）。apiKey 只以
 *   AES-256-GCM 密文落库（LLM_ENC_KEY），对外只回显掩码。
 *
 * 鉴权：两个面都要求 kind='user'（401）；admin 面额外要求 accounts.is_admin（403）。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AdminLlmCatalogViewSchema,
  LlmCatalogUpsertSchema,
  UserLlmConfigSaveSchema,
  UserLlmConfigValidateSchema,
  UserLlmConfigGetResponseSchema,
  UserLlmConfigViewSchema,
  type AdminCatalogModelView,
  type StoredUserLlmConfig,
} from '@jobagent/shared';
import {
  decryptApiKey,
  encryptApiKey,
  maskApiKey,
  OpenAICompatibleClient,
} from '@jobagent/llm';
import { oneHourAgo } from '../demo-config.js';
import { checkLlmEndpoint } from '../llm-endpoint-guard.js';
import type { RouteDeps } from './context.js';
import type { HonoEnv } from './types.js';

const AUTH_REQUIRED = 'AUTH_REQUIRED';
const FORBIDDEN = 'FORBIDDEN';
const ENCRYPTION_NOT_CONFIGURED = 'ENCRYPTION_NOT_CONFIGURED';
const LLM_VALIDATION_FAILED = 'LLM_VALIDATION_FAILED';
const LLM_ENDPOINT_BLOCKED = 'LLM_ENDPOINT_BLOCKED';
const LLM_VALIDATE_RATE_LIMITED = 'LLM_VALIDATE_RATE_LIMITED';
const BAD_REQUEST = 'BAD_REQUEST';
const CATALOG_SYNCED_FROM_HUB = 'CATALOG_SYNCED_FROM_HUB';
const HUB_NOT_CONFIGURED = 'HUB_NOT_CONFIGURED';
const HUB_SYNC_FAILED = 'HUB_SYNC_FAILED';
/** /validate 的 IP 滑窗上限（次/小时）：该端点会替用户向任意地址发一次真实请求，
 *  不加限频就是一个端口扫描原语（审查 P0-3）。固定值、非产品旋钮，故不走 env。 */
const LLM_VALIDATE_RATE_PER_HOUR = 20;

/** 守卫结果：ok=true 携带 accountId；ok=false 携带已写入的 Response。 */
export type GuardResult = { ok: true; accountId: string } | { ok: false; response: Response };

/** 只允许登录用户（kind='user'）；匿名/demo 一律 401。导出供 usage 等路由复用同一闸。 */
export async function requireUser(c: Context, d: RouteDeps): Promise<GuardResult> {
  const principal = c.get('principal');
  if (principal.kind !== 'user') {
    return { ok: false, response: c.json({ error: 'login required', code: AUTH_REQUIRED }, 401) };
  }
  const account = await d.repos.accounts.getById(principal.accountId);
  if (!account) {
    return { ok: false, response: c.json({ error: 'account not found', code: AUTH_REQUIRED }, 401) };
  }
  return { ok: true, accountId: principal.accountId };
}

/** admin 面：登录用户 + is_admin；非 admin 一律 403。导出供 usage 等路由复用同一闸。 */
export async function requireAdmin(c: Context, d: RouteDeps): Promise<GuardResult> {
  const user = await requireUser(c, d);
  if (!user.ok) return user;
  const account = await d.repos.accounts.getById(user.accountId);
  if (!account?.isAdmin) {
    return { ok: false, response: c.json({ error: 'admin privilege required', code: FORBIDDEN }, 403) };
  }
  return { ok: true, accountId: user.accountId };
}

/** 目录行 → admin 视图（含来源投影字段；凭证字段结构上不存在）。 */
async function toCatalogView(d: RouteDeps) {
  const hubConfigured = d.hubCatalog !== null;
  const stored = await d.repos.llmCatalog.listAll();
  let models: AdminCatalogModelView[];
  if (stored.length === 0) {
    // 空表：本地模式回退代码默认（builtin）；hub 模式下空表即未分配（空）。
    if (hubConfigured) {
      models = [];
    } else {
      models = d.catalogCache.get().map((m) => ({
        ...m,
        source: 'builtin' as const,
        revision: null,
        assignmentId: null,
      }));
    }
  } else {
    // listAll orders sortOrder desc; the view (and catalogCache) uses asc.
    const ordered = [...stored].sort((a, b) => a.sortOrder - b.sortOrder);
    models = ordered.map((m) => ({
      id: m.id,
      provider: m.provider,
      model: m.model,
      enabled: m.enabled,
      isDefault: m.isDefault,
      sortOrder: m.sortOrder,
      modalities: m.modalities,
      source: m.source,
      revision: m.revision,
      assignmentId: m.assignmentId,
    }));
  }
  return {
    models,
    // 只回"内置凭证是否已配置"，绝不回显任何 key 内容
    envConfigured: Boolean(process.env.LLM_API_KEY?.trim()),
    hubConfigured,
    revision: d.hubCatalog?.kit.revision ?? null,
  };
}

/** 仓储行 → BYOK 对外视图（只给掩码）。 */
function toConfigView(cfg: StoredUserLlmConfig, encKey: string): unknown {
  const plaintext = decryptApiKey(cfg.apiKeyEncrypted, encKey);
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    keyMasked: maskApiKey(plaintext),
  };
}

/** 简化审计日志（完整审计表缓做，见 design §4.2）：不记凭证、不记价格。 */
function logAdminAction(action: string, actor: string, modelIds: string[]) {
  console.log(
    `[admin-catalog] action=${action} actor=${actor} models=${modelIds.join(',') || '-'}`,
  );
}

export function registerLlmRoutes(app: Hono<HonoEnv>, d: RouteDeps): void {
  // ── 内置目录（admin 面，迁移 024）───────────────────────────────────────────
  app.get('/admin/llm-catalog', async (c) => {
    const guard = await requireAdmin(c, d);
    if (!guard.ok) return guard.response;
    const view = AdminLlmCatalogViewSchema.parse(await toCatalogView(d));
    return c.json(view);
  });

  // 当 hub 启用时，目录由 model-hub 投影同步，手工 PUT 一律拒绝（409）；
  // hub 未配置（迁移期）时保留本地整体替换语义。
  app.put('/admin/llm-catalog', async (c) => {
    const guard = await requireAdmin(c, d);
    if (!guard.ok) return guard.response;
    if (d.hubCatalog) {
      c.status(409);
      return c.json({
        error: 'catalog is synced from model-hub and is read-only',
        code: CATALOG_SYNCED_FROM_HUB,
      });
    }
    const body = LlmCatalogUpsertSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      c.status(400);
      return c.json({ error: 'invalid catalog payload', code: BAD_REQUEST });
    }
    const nowIso = d.now();
    // 整体替换：行的时间戳由服务端填，目录字段完全来自请求（白名单在合并层强制）
    await d.repos.llmCatalog.replaceAll(
      body.data.models.map((m) => ({ ...m, createdAt: nowIso, updatedAt: nowIso })),
    );
    d.catalogCache.refresh(body.data.models);
    logAdminAction(
      'catalog_update',
      guard.accountId,
      body.data.models.map((m) => m.id),
    );
    return c.json(AdminLlmCatalogViewSchema.parse(await toCatalogView(d)));
  });

  // 手动触发一次 hub 同步（拉投影 → 写表 → 刷新缓存）。
  app.post('/admin/llm-catalog/sync', async (c) => {
    const guard = await requireAdmin(c, d);
    if (!guard.ok) return guard.response;
    if (!d.hubCatalog) {
      c.status(409);
      return c.json({ error: 'model-hub is not configured', code: HUB_NOT_CONFIGURED });
    }
    try {
      const result = await d.hubCatalog.sync();
      logAdminAction('catalog_sync', guard.accountId, []);
      return c.json({
        ...AdminLlmCatalogViewSchema.parse(await toCatalogView(d)),
        sync: result,
      });
    } catch (err) {
      c.status(502);
      return c.json({
        error: 'hub sync failed',
        code: HUB_SYNC_FAILED,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // refresh：hub 启用时等价于一次 hub sync；否则保留本地重读仓储语义
  // （例如外部 DDL 直改）。
  app.post('/admin/llm-catalog/refresh', async (c) => {
    const guard = await requireAdmin(c, d);
    if (!guard.ok) return guard.response;
    if (d.hubCatalog) {
      try {
        await d.hubCatalog.sync();
      } catch (err) {
        c.status(502);
        return c.json({
          error: 'hub sync failed',
          code: HUB_SYNC_FAILED,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      logAdminAction('catalog_sync', guard.accountId, []);
      return c.json(AdminLlmCatalogViewSchema.parse(await toCatalogView(d)));
    }
    const rows = await d.repos.llmCatalog.listAll();
    d.catalogCache.refresh(rows);
    logAdminAction('catalog_refresh', guard.accountId, rows.map((r) => r.id));
    return c.json(AdminLlmCatalogViewSchema.parse(await toCatalogView(d)));
  });

  // ── BYOK（登录用户，迁移 025）──────────────────────────────────────────────
  // GET 契约：**始终 200**。未配置 / 服务端缺加密 key 都用 configured 标记表达，
  // 避免浏览器把 4xx 记为资源加载错误（workbench E2E consoleErrors 断言依赖）。
  app.get('/account/llm-config', async (c) => {
    const guard = await requireUser(c, d);
    if (!guard.ok) return guard.response;
    const cfg = await d.repos.userLlmConfigs.getByAccountId(guard.accountId);
    if (!cfg) {
      return c.json(UserLlmConfigGetResponseSchema.parse({ configured: false }));
    }
    if (!d.llmEncKey) {
      return c.json(
        UserLlmConfigGetResponseSchema.parse({ configured: false, reason: 'encryption_missing' }),
      );
    }
    const view = UserLlmConfigViewSchema.parse(toConfigView(cfg, d.llmEncKey));
    return c.json(UserLlmConfigGetResponseSchema.parse({ configured: true, ...view }));
  });

  app.put('/account/llm-config', async (c) => {
    const guard = await requireUser(c, d);
    if (!guard.ok) return guard.response;
    const body = UserLlmConfigSaveSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      c.status(400);
      return c.json({ error: 'invalid BYOK config payload', code: BAD_REQUEST });
    }
    if (!d.llmEncKey) {
      c.status(503);
      return c.json({ error: 'encryption key not configured on the server', code: ENCRYPTION_NOT_CONFIGURED });
    }
    // 决策 #26：保存前就挡住云元数据/link-local，避免把坏地址落库后再由调用点兜底。
    if (!checkLlmEndpoint(body.data.baseUrl).ok) {
      c.status(400);
      return c.json({ error: 'baseUrl is not an allowed LLM endpoint', code: LLM_ENDPOINT_BLOCKED });
    }
    const existing = await d.repos.userLlmConfigs.getByAccountId(guard.accountId);
    const apiKey = body.data.apiKey ?? (existing ? decryptApiKey(existing.apiKeyEncrypted, d.llmEncKey) : null);
    if (!apiKey) {
      // 既无旧配置又没给 key：无法保存一个没有凭证的 BYOK 配置
      c.status(400);
      return c.json({ error: 'apiKey is required when no config exists yet', code: BAD_REQUEST });
    }
    const nowIso = d.now();
    const saved = await d.repos.userLlmConfigs.upsert({
      accountId: guard.accountId,
      provider: body.data.provider,
      baseUrl: body.data.baseUrl,
      model: body.data.model,
      apiKeyEncrypted: encryptApiKey(apiKey, d.llmEncKey),
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
    return c.json(UserLlmConfigViewSchema.parse(toConfigView(saved, d.llmEncKey)));
  });

  app.delete('/account/llm-config', async (c) => {
    const guard = await requireUser(c, d);
    if (!guard.ok) return guard.response;
    await d.repos.userLlmConfigs.deleteByAccountId(guard.accountId);
    c.status(204);
    return c.body(null);
  });

  app.post('/account/llm-config/validate', async (c) => {
    const guard = await requireUser(c, d);
    if (!guard.ok) return guard.response;
    // 限频放在最前：校验失败/404 也计入，避免用错误请求探测。
    const ipHash = d.ipHashOf(c);
    if (ipHash) {
      const rateNow = d.now();
      const recent = await d.repos.demoSessions.countRateEvents(
        ipHash,
        'llm-validate',
        oneHourAgo(rateNow),
      );
      if (recent >= LLM_VALIDATE_RATE_PER_HOUR) {
        c.status(429);
        return c.json(
          {
            error: 'too many validation attempts',
            code: LLM_VALIDATE_RATE_LIMITED,
            retryAfterSeconds: 3600,
          },
          429,
        );
      }
      await d.repos.demoSessions.insertRateEvent(ipHash, 'llm-validate', rateNow);
    }
    const body = UserLlmConfigValidateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      c.status(400);
      return c.json({ error: 'invalid validation payload', code: BAD_REQUEST });
    }
    const typed = body.data;
    if ((typed.baseUrl || typed.model) && !typed.apiKey) {
      // 给了新端点却没给 key：不能拿已保存的 key 去打这个新地址（见 shared 契约注释）
      c.status(400);
      return c.json({
        error: 'testing an unsaved baseUrl/model requires its apiKey',
        code: BAD_REQUEST,
      });
    }

    // 没有 key 就整组用已保存的配置——这才是"测试连接"按钮的真实用法：密钥框保存后
    // 本来就是空的（GET 只回掩码），要求它再敲一次 key 等于让该按钮永远不可用。
    let target: { baseUrl: string; model: string; apiKey: string } | null = null;
    if (typed.apiKey && typed.baseUrl && typed.model) {
      target = { baseUrl: typed.baseUrl, model: typed.model, apiKey: typed.apiKey };
    } else if (d.llmEncKey) {
      const saved = await d.repos.userLlmConfigs.getByAccountId(guard.accountId);
      const plaintext = saved ? decryptApiKey(saved.apiKeyEncrypted, d.llmEncKey) : null;
      if (saved && plaintext) {
        target = { baseUrl: saved.baseUrl, model: saved.model, apiKey: plaintext };
      }
    }
    if (!target) {
      c.status(400);
      return c.json({ error: 'apiKey is required when no config exists yet', code: BAD_REQUEST });
    }

    // 决策 #26：新地址与已存地址都过同一道守卫（已存配置可能早于本次修复落库）。
    if (!checkLlmEndpoint(target.baseUrl).ok) {
      c.status(400);
      return c.json({ error: 'baseUrl is not an allowed LLM endpoint', code: LLM_ENDPOINT_BLOCKED });
    }

    try {
      // 最小验证：max_tokens=1 的真实请求（用户自己的 key 打用户自己的端点）
      const client = new OpenAICompatibleClient({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
      });
      await client.generateJson({
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        requestId: `byok-validate-${guard.accountId}`,
      });
      return c.json({ ok: true, provider: client.provider, model: client.model });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      c.status(502);
      return c.json({
        ok: false,
        error: `validation failed: ${detail}`,
        code: LLM_VALIDATION_FAILED,
      });
    }
  });
}
