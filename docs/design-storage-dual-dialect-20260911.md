# 设计：持久化层双方言（SQLite / Postgres）适配

- 状态：**现行**
- 日期：2026-09-11
- 对应里程碑：M1·W3-6（storage 双轨）
- 关联：[技术选型-MVP-20260910.md](技术选型-MVP-20260910.md) §6.5/§6.11、Spike S6、[../MIGRATION_CONVENTION.md](../MIGRATION_CONVENTION.md)、[../AGENTS.md](../AGENTS.md)「数据访问抽象层」、[deferred-items.md](deferred-items.md)「Postgres 方言适配」
- 验收标准（技术选型 Spike S6）：**切换数据库不改业务代码**——`apps/api`、`apps/worker`、`apps/report` 只依赖仓储接口与连接工厂，不感知 Drizzle 方言与驱动。

## 1. 背景与目标

技术选型已定：在线服务主轨是 **PostgreSQL + Drizzle ORM（驱动 postgres-js）**，SQLite 仅用于本地开发、#8 离线标注实验与单机工具。当前持久化层只实现了 SQLite 一侧，且在四个位置与 better-sqlite3 **同步**驱动强绑定：

1. `schema.ts` 使用 `drizzle-orm/sqlite-core`（`sqliteTable/text/integer`）。
2. 四个仓储构造函数写死 `BetterSQLite3Database`，查询用**同步终结符** `.run()/.get()/.all()`，`transaction()` 也是同步。
3. `migrator.ts`、`cli.ts` 直接依赖 better-sqlite3 的 `Database` 与文件路径。
4. `apps/api`、`apps/worker` 的 `initRepos(dbPath)`、`apps/report/src/lib/db.ts` 直接 `new Database(path)` + `drizzle(db)`。

Postgres 驱动（postgres-js）**全异步**，因此双轨不是"再加一套 schema"那么简单，必须先把仓储访问统一成 async，再分叉方言。本设计完成后：

- 本地/实验：零配置，默认 SQLite 文件库（现状体验不变）。
- 生产：设置 `DB_DRIVER=postgres` + `DATABASE_URL` 即切到 Postgres，**业务代码零改动**。
- 方言差异（schema、SQL 迁移、驱动、事务）**只允许出现在 `packages/storage` 内部**。

## 2. 设计原则

1. **业务不感知方言**：apps 只 import 仓储接口类型与 `createStorage()`，不 import 任何 `drizzle-orm/*-core`、不接触驱动。
2. **类型安全优先于代码复用**：Drizzle 的 sqlite-core 与 pg-core 表对象类型不兼容，强行用一份泛型仓储吃两种表会引入大量断言。4 张表规模下，选择"**双 schema + 双仓储实现 + 共享领域纯逻辑**"，换取零 `any`、双方言各自类型完整。
3. **行为一致性靠测试守护**：同一套仓储行为用例参数化跑两个方言实现；schema/迁移的结构一致性用不依赖数据库实例的静态测试对齐，防止双实现漂移。
4. **只追加、可回滚**：迁移编号 001–004 保持不复用；本次只做目录对称化，不改写任何已存在迁移的内容与编号。
5. **列类型刻意求同**：MVP 阶段 Postgres 侧也用 `TEXT` 承载 JSON/时间戳字符串、`BOOLEAN` 承载布尔，与 SQLite 行类型一一对齐，把 JSONB/TIMESTAMPTZ 等原生类型优化留给后续（见 §9）。

## 3. 目标结构

```text
packages/storage/src/
├─ entities/                  # 【共享】方言无关的领域类型 + 纯映射逻辑
│  ├─ profile.ts              #   StoredProfile/NewProfile/ProfileStatus + toStoredProfile/parseSnapshot
│  ├─ analysis-job.ts         #   StoredAnalysisJob/NewAnalysisJob/枚举 + toStoredJob/parseJson
│  ├─ evidence.ts             #   StoredEvidence/NewEvidence + 映射
│  └─ waitlist.ts             #   StoredWaitlist/NewWaitlist/枚举 + 映射
├─ repositories/              # 【接口】统一 async 仓储契约（业务只依赖这里）
│  ├─ profiles.ts             #   interface IProfilesRepository
│  ├─ analysis-jobs.ts        #   interface IAnalysisJobsRepository
│  ├─ evidence.ts             #   interface IEvidenceRepository
│  └─ waitlist.ts             #   interface IWaitlistRepository
├─ sqlite/                    # 【SQLite 实现】现状代码迁移并 async 化
│  ├─ schema.ts               #   sqliteTable（现 schema.ts）
│  ├─ migrator.ts             #   现 migrator.ts（同步驱动，包在 async 接口后）
│  ├─ profiles-repo.ts …      #   4 个仓储实现（方法 async，内部仍同步执行）
│  └─ connection.ts           #   openSqlite(path,{readonly}) → drizzle 实例
├─ postgres/                  # 【Postgres 实现，新增】
│  ├─ schema.ts               #   pgTable（pg-core）
│  ├─ migrator.ts             #   异步迁移器（postgres-js 执行 pg 迁移目录）
│  ├─ profiles-repo.ts …      #   4 个仓储实现（await 查询）
│  └─ connection.ts           #   openPostgres(url) → postgres-js + drizzle 实例 + 连接池
├─ storage.ts                 # createStorage(config)：按 driver 装配，返回统一 StorageContext
├─ types.ts                   # StorageContext/StorageDriver/StorageConfig/Closeable
└─ cli.ts                     # migrate up/down/status，支持 --driver 与环境变量

db/migrations/
├─ sqlite/001..004_*.sql      # 现 db/migrations/*.sql 原样 git mv（SQLite 方言、内联注释）
└─ postgres/001..004_*.sql    # 新增：PG 方言（BOOLEAN、COMMENT ON、同表名/列名/索引名/编号）
```

> 旧文件路径 `packages/storage/src/schema.ts`、`profiles.ts` 等按上表拆分；`index.ts` 只再导出接口、实体类型、工厂与枚举，**不再导出任何方言表对象给业务**（测试需要的测试辅助从单独子路径导出）。

## 4. 关键决策

### D1 仓储接口统一为 async（破坏性重构，但一次性到位）

所有仓储公开方法返回 `Promise`：

```ts
// repositories/profiles.ts
export interface IProfilesRepository {
  insert(profile: NewProfile): Promise<void>;
  getById(id: string): Promise<StoredProfile | undefined>;
  listBySubject(platform: string, login: string, limit?: number): Promise<StoredProfile[]>;
  latestBySubject(platform: string, login: string): Promise<StoredProfile | undefined>;
  updateStatus(id: string, status: ProfileStatus): Promise<void>;
}
```

- SQLite 实现内部驱动是同步的，方法声明 `async`、直接 `return` 同步结果即可（`async` 会自动包 Promise），调用侧与 PG 完全一致。
- 写操作返回 `Promise<void>`；查询返回 `Promise<T>`；`claimNext` 返回 `Promise<StoredAnalysisJob | null>`。
- 业务侧（api 路由、worker 循环、report SSR）全部 `await`；Hono 路由与 Astro SSR 本就是 async，worker 主循环也是 async，改造为机械加 await。

### D2 双 schema + 双仓储实现 + 共享实体层

- `sqlite/schema.ts` = 现 `schema.ts`（`sqliteTable`）；`postgres/schema.ts` 用 `pgTable/text/boolean/timestamp?`（见 D4）新写，**表名、列名（snake_case）、索引名、默认值语义必须逐一对齐**。
- 行类型（`Stored*`/`New*`）、枚举（状态/阶段/来源）、`JSON.parse` 兜底、非法枚举降级、快照 Zod 解析等**纯逻辑抽到 `entities/`**，两套实现共用，杜绝映射逻辑分叉。
- 每个仓储有 sqlite/postgres 两个实现类，都 `implements I*Repository`；TS 结构性类型保证两边接口不缺方法。

### D3 迁移目录对称化（git mv，内容零改动）

- 现 `db/migrations/001..004_*.sql` 用 `git mv` 移到 `db/migrations/sqlite/`，**内容、编号、down 段一律不动**。
- 新增 `db/migrations/postgres/001..004_*.sql`，编号与文件名一一对应。
- `migrator` 的迁移目录参数按 driver 传入；`listMigrationFiles/parseMigrationFile`（纯文件解析、与方言无关）提升为共享函数，sqlite/postgres 两个 migrator 复用。
- `MIGRATION_CONVENTION.md` §1 目录表更新为双目录；`tools/check-migrations.sh` 从"校验单目录"扩展为"分别校验两目录 + 跨目录文件名/编号集合必须一致"。
- 备选方案（**未采纳**）：保留 `db/migrations/` 给 SQLite、只新增 `postgres/` 子目录。优点是不动旧路径；缺点是长期语义不对称（根目录隐含 sqlite）。当前迁移未上生产、无数据负担，一次性对称化更清晰。如偏好最小改动可回退此方案，不影响其余设计。

### D4 Postgres 列类型策略（MVP 与 SQLite 对齐，不急于原生类型）

| 语义 | SQLite（现状） | Postgres（本设计） | 说明 |
| --- | --- | --- | --- |
| 主键/字符串/枚举 | `TEXT` | `TEXT` | 一致 |
| JSON（snapshot、budget_used、missing、analysis_layers） | `TEXT`（应用层 stringify） | `TEXT`（同样 stringify） | 行类型完全一致；**JSONB 延后** |
| 时间戳（created_at 等，ISO8601 字符串） | `TEXT DEFAULT (CURRENT_TIMESTAMP)` | `TEXT DEFAULT CURRENT_TIMESTAMP` | 应用层一律显式写 `toISOString()`，默认值仅兜底；**TIMESTAMPTZ 延后** |
| 布尔 subject_claimed | `INTEGER` 0/1（Drizzle boolean mode） | `BOOLEAN` false/true（Drizzle boolean mode） | 仓储层都是 TS `boolean` |
| 整数 attempts | `INTEGER` | `INTEGER` | 一致 |
| 索引 | `CREATE INDEX IF NOT EXISTS` | 同语法 | 名称一致 |

- PG 迁移按 `MIGRATION_CONVENTION §4` 用 `COMMENT ON TABLE/COLUMN` 写清每列含义与枚举取值（SQLite 侧继续用内联 `--` 注释）。
- 刻意不引入 `UUID`、`GEN_RANDOM_UUID`：id 由应用层生成（现状），双方言一致。

### D5 连接工厂与环境变量（12-factor）

```ts
// types.ts
export type StorageDriver = 'sqlite' | 'postgres';
export interface StorageConfig {
  driver?: StorageDriver;     // 默认取 DB_DRIVER，再缺省 'sqlite'
  sqlitePath?: string;        // 默认 DB_PATH ?? 'data/job-agent.db'
  databaseUrl?: string;       // postgres 取 DATABASE_URL
  readonly?: boolean;         // report 只读连接用
  autoMigrate?: boolean;      // 默认 true：工厂内按序应用未执行迁移
}
export interface StorageContext {
  driver: StorageDriver;
  profiles: IProfilesRepository;
  jobs: IAnalysisJobsRepository;
  evidence: IEvidenceRepository;
  waitlist: IWaitlistRepository;
  migrate(): Promise<RunMigrationsResult>;
  close(): Promise<void>;
}
export function createStorage(config?: StorageConfig): Promise<StorageContext>;
```

- 选择规则：`config.driver ?? process.env.DB_DRIVER ?? 'sqlite'`。`postgres` 时必须有 `DATABASE_URL`，否则抛带修复提示的错误（不静默回退）。
- sqlite：`better-sqlite3` 文件/内存；report 传 `readonly:true`（保留"只读连接不执行 WAL pragma"的既有教训）。
- postgres：`postgres(connectionString)` 建连接池 → `drizzle(client, { schema: pgSchema })`；`close()` 调 `client.end()`。
- `.env.example` 补：`DB_DRIVER=`（sqlite|postgres）、`DB_PATH=`、`DATABASE_URL=`（注释说明生产用、密钥不入库）。

### D6 任务认领事务（claimNext）双方言实现

- 语义不变：事务内"SELECT 最老 queued（attempts<3）→ UPDATE 该 id 且 `WHERE status='queued'` 双重校验 → 返回被更新行"，保证单 Worker/多 Worker 都只认领先一行。
- SQLite：`db.transaction(tx => {...})` 同步（现状）。
- Postgres：`await db.transaction(async (tx) => {...})`；默认 READ COMMITTED 下 UPDATE 行锁已足够保证唯一认领。
- **延后**：`SELECT ... FOR UPDATE SKIP LOCKED`（多 Worker 高并发时再优化，记 deferred，触发条件=多 Worker 并发且认领竞争可见）。

### D7 驱动选型：postgres-js（遵循既定技术选型）

技术选型 §6.5 已写明 **postgres-js**（`postgres` 包，`drizzle-orm/postgres-js`），且本地 `pr-helper` 有实操经验；不更换为 `node-postgres(pg)`。新增依赖只进 `packages/storage`：`postgres`（版本安装时取当期稳定，写入 lockfile）。

## 5. 业务侧改造清单（async 波及面，已逐文件确认）

| 文件 | 改造 |
| --- | --- |
| `apps/api/src/index.ts` | `initRepos(dbPath)` → `await createStorage()`；路由内所有仓储调用加 `await`；`ApiRepos` 类型改用 `I*Repository` |
| `apps/api/src/index.test.ts` | 注入的 fake repos 方法改为返回 Promise（`async`/`Promise.resolve`），用例 `await` |
| `apps/worker/src/index.ts` | `initRepos` → 工厂；`processJob/handleJobFailure/runWorker` 内仓储调用 `await` |
| `apps/worker/src/index.test.ts` | fake repos Promise 化；219–220 行穿透 `$client` 的 raw SQL 辅助改 async 获取连接 |
| `apps/report/src/lib/db.ts` | 改用 `createStorage({readonly:true})` 单例；`loadProfile` 改 `async` |
| `apps/report/src/pages/.../[profileId].astro` | `await loadProfile(id)`（Astro SSR 原生支持） |
| `packages/storage/src/cli.ts` | 按 `--driver`/环境变量选择 sqlite/postgres 连接与迁移目录；PG 路径为 async |
| 根 `package.json` | `migrate:*` 脚本透传 driver（SQLite 默认行为不变） |

## 6. 测试策略（四层，不强制本机装 Postgres）

1. **SQLite 行为测试（现状延续）**：内存库跑全部仓储 + 迁移用例，调用改 `await`，仍是 CI 主力，零外部依赖。
2. **双方言 schema 结构一致性（新增，无实例）**：分别从 sqlite/pg 的 Drizzle 表定义提取表名集合、每张表列名集合、索引名集合，断言完全相等。
3. **双方言迁移一致性（新增，纯文本）**：两目录文件名/编号集合相等且连续；每份 PG 迁移都含 down 段与文件头；正则提取双方 `CREATE TABLE/INDEX` 的表名、列名、索引名集合对齐。
4. **Postgres 行为测试（新增，条件跳过）**：同一套仓储行为用例参数化到 PG 实现；仅当存在 `DATABASE_TEST_URL` 时运行，否则 `describe.skip` 并打印"未配置 DATABASE_TEST_URL，跳过 PG 实库测试"。CI 加 Postgres service 的工作**独立后做**（记 handoff 待办），本次不阻塞。

`check-migrations.sh` 扩展后纳入交付前门禁（`bash tools/check-migrations.sh` 同时校验两目录）。

## 7. 实施步骤（对应原子提交，每步全仓 typecheck/test/build 全绿再进下一步）

1. `docs`：本设计文档 + 更新 MIGRATION_CONVENTION/AGENTS/deferred（标记触发重启）+ handoff 登记 + docs/README 入口。
2. `chore(db)`：`git mv db/migrations/*.sql db/migrations/sqlite/`（内容不改），迁移目录引用、check 脚本先适配 sqlite 子目录，保证现状全绿。
3. `refactor(storage)`：抽 entities/repositories 接口，仓储与业务调用链**全 async 化（此时仍只有 SQLite）**，全仓测试改 await 并全绿——纯重构、行为不变，单独成提交便于回滚。
4. `feat(storage)`：新增 postgres schema/迁移/仓储/连接工厂、`createStorage`、postgres-js 依赖、第 2/3/4 层测试。
5. `chore`：`.env.example`、根迁移脚本、storage cli 的 driver 支持、check-migrations 双目录校验。
6. `docs(handoff)`：标记 W3-6 完成、记录残余项（CI PG service、DATABASE_TEST_URL 实测）。

> 步骤 3 与 4 拆开的原因：async 化是跨全仓的破坏性重构，先独立落地并证明"行为不变"，再加方言，出问题时二分定位清晰，符合原子提交。

## 8. 验证与完成定义

- `pnpm -r typecheck` / `pnpm -r test` / `pnpm -r build` 全绿；`bash tools/check-migrations.sh` 双目录通过；`git diff --check` 干净。
- SQLite 默认路径行为与改造前一致（CLI migrate up/down/status、内存库迁移回滚测试全过）。
- 配置 `DB_DRIVER=postgres` + `DATABASE_URL` 时，api/worker/report 无需改代码即可连 PG（本机若无实例，由 schema/迁移一致性测试 + 条件跳过的 PG 用例保证，实库联调列入待办并显式标注未覆盖）。
- apps 源码 grep 不到 `drizzle-orm/sqlite-core`、`drizzle-orm/pg-core`、`better-sqlite3`、`postgres` 这些只属于持久化层的 import。

## 9. 明确不做（缓做，登记 deferred-items 并带触发条件）

- JSONB / TIMESTAMPTZ / 原生 UUID 列类型升级——触发：需要在 DB 层查询 JSON 内部字段、做原生时间运算或跨时区排序。
- `FOR UPDATE SKIP LOCKED`、多 Worker 并发压测与连接池参数调优——触发：多 Worker 并发且出现认领竞争/连接耗尽。
- CI 的 Postgres service container 与 `DATABASE_TEST_URL` 注入——触发：准备部署 PG 或首次接入托管 PG 时（与 S5/S6 部署 spike 同期）。
- 数据从 SQLite 到 Postgres 的迁移/导出工具——触发：出现需要保留的真实线上数据时（MVP 实验数据可丢弃/重跑）。
- 多区域 PG 部署、读写分离、备份策略——部署期由 §6.11 托管方案承接。

## 10. 待拍板项（不阻塞开工，默认按括号方案执行）

1. **迁移目录形态**：默认 D3 对称双目录 `db/migrations/{sqlite,postgres}/`；若希望最小改动可保留根目录给 SQLite（仅新增 postgres 子目录）。
2. **PG 实库测试时机**：默认本次只交付静态一致性测试 + 条件跳过用例（本机不要求装 PG/Docker）；若你希望本次就用本机 Docker Postgres 跑通真实 PG 行为测试，请确认本机 Docker 可用。
3. **PG 列类型**：默认 D4 全部对齐 SQLite（TEXT/BOOLEAN）；若希望 snapshot 等 JSON 列一步到位用 JSONB，需要在实体层增加双方言序列化差异，工作量略增。
