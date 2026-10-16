# M0 地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭好 Capybara 仓库骨架与工程 harness，并实现内核地基：配置、PG 迁移器、插件 `ctx`、插件宿主、双副本测试工具，使一个示例插件能在双副本下跑通。

**Architecture:** pnpm monorepo。`packages/plugin-sdk` 只含类型与纯函数（插件唯一可 import 的内核包）；`packages/kernel` 实现配置、数据库、`ctx` 服务、插件宿主与 HTTP；`packages/testing` 提供双副本测试工具；`apps/capybara` 是 CLI 入口（`start`、`migrate`）。自定义检查放在 `tools/checks`，每道检查都带「会红」的 fixture。

**Tech Stack:** Node.js 24、TypeScript、pnpm workspaces、Hono、Kysely + 纯 SQL 迁移、Zod 4、ioredis、BullMQ、Vitest、Testcontainers、Biome、Changesets、commitlint、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-17-capybara-architecture-design.md`（路线图：`docs/superpowers/plans/2026-10-17-mvp-roadmap.md`）

## Global Constraints

- 包名一律 `@capybara-hq/<name>`；许可证 Apache-2.0。
- 环境变量统一前缀 `CAPYBARA_`；嵌套键用双下划线：`CAPYBARA_DB__URL` → `db.url`。环境变量优先级最高。
- 配置来源由 `CAPYBARA_CONFIG_SOURCE` 选择：`file`（读 `CAPYBARA_CONFIG_FILE`）或 `nacos`（`CAPYBARA_NACOS_SERVER` / `CAPYBARA_NACOS_NAMESPACE` / `CAPYBARA_NACOS_DATA_ID`）。
- 插件只能 import `@capybara-hq/plugin-sdk` 与第三方 npm 包，不能 import `@capybara-hq/kernel`。
- `ctx` 不提供定时器、不提供进程内共享对象；`ctx.kv` 写入必须带 TTL。
- 插件 PG schema 名为 `plugin_<name>`（name 中的 `-` 换成 `_`）；内核 schema 为 `capybara`。
- BullMQ 队列名与 job id 不得含 `:`。
- 所有迁移是 SQL 文件，命名 `NNNN_<snake_desc>.sql`；建删对象必须带 `IF NOT EXISTS` / `IF EXISTS`。
- 给模型看的文案一律英文（M0 不涉及，写进 AGENTS.md）。
- 每道自定义检查必须有一个「违规 fixture 使其失败」的测试。
- 依赖装当时最新稳定版。

## Review Focus

1. **滚动发布时两个副本同时执行 `capybara migrate`**：只有一个真正执行，另一个等待后发现已是最新、不报错退出。→ Task 4 `concurrent migrate` 测试。
2. **环境变量覆盖类型错误**（如 `CAPYBARA_DB__POOL_MAX=abc`）：启动失败，错误信息点名 `db.poolMax`，而不是静默用默认值。→ Task 2 测试。
3. **锁持有者崩溃**：锁在 TTL 后过期，其他副本能拿到；释放时不会误删别人的锁。→ Task 7 测试。
4. **插件依赖缺失或单选能力冲突**：启动失败并列出涉及的插件名与能力名。→ Task 10 测试。
5. **主密钥缺失、长度不对、或轮换后读旧数据**：启动时明确报错；轮换后旧密文仍可解密。→ Task 9 测试。

---

## 文件结构

```
capybara/
├── AGENTS.md  CLAUDE.md  README.md  CONTRIBUTING.md  LICENSE  NOTICE
├── package.json  pnpm-workspace.yaml  tsconfig.base.json  biome.json
├── vitest.config.ts  commitlint.config.ts  .changeset/config.json
├── .github/workflows/ci.yml  .github/pull_request_template.md
├── docker/compose.dev.yaml                  # 本地开发用 PG + Valkey
├── docs/config.md                           # 由 schema 生成，勿手改
├── skills/                                  # 仓库开发技能（.claude/skills 软链到此）
│   ├── writing-migrations/SKILL.md
│   ├── adding-config/SKILL.md
│   └── writing-plugins/SKILL.md
├── packages/
│   ├── plugin-sdk/src/{index,define-plugin,capability,ctx,secret}.ts
│   ├── kernel/src/
│   │   ├── config/{schema,env,load,file-source,nacos-source,docs}.ts
│   │   ├── db/{pool,migrator}.ts
│   │   ├── ctx/{kv,lock,bus,queue,secrets,create-ctx}.ts
│   │   ├── plugins/{host,resolve}.ts
│   │   ├── http/{app,health}.ts
│   │   ├── kernel.ts                       # createKernel / start / stop
│   │   └── migrations/0001_init.sql        # capybara schema 的迁移
│   └── testing/src/{containers,dual-replica}.ts
├── apps/capybara/src/{cli,commands/start,commands/migrate}.ts
├── plugins/example-counter/                 # 示例插件
└── tools/checks/src/{deps,plugin-state,migrations,config-docs}.ts
    └── fixtures/                            # 每道检查的违规样本
```

---

### Task 1: 仓库骨架与 CI

**Files:**
- Create: 根目录 `package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`biome.json`、`vitest.config.ts`、`commitlint.config.ts`、`.changeset/config.json`、`LICENSE`（Apache-2.0 全文）、`NOTICE`、`README.md`、`CONTRIBUTING.md`、`AGENTS.md`、`CLAUDE.md`、`.github/workflows/ci.yml`、`.github/pull_request_template.md`、`docker/compose.dev.yaml`
- Create: `packages/plugin-sdk/package.json`、`packages/plugin-sdk/src/index.ts`、`packages/plugin-sdk/test/smoke.test.ts`
- Create: 软链 `.claude/skills -> ../skills`

**Interfaces:**
- Produces: 根脚本 `pnpm lint`（biome check）、`pnpm typecheck`（`tsc -b`）、`pnpm test`（vitest run）、`pnpm check`（Task 13 起逐步加入各检查）。

- [ ] **Step 1: 写冒烟测试** `packages/plugin-sdk/test/smoke.test.ts`：`expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/)`。
- [ ] **Step 2: 运行确认失败**：`pnpm test` → FAIL（`SDK_VERSION` 未导出）。
- [ ] **Step 3: 实现** `packages/plugin-sdk/src/index.ts` 导出 `export const SDK_VERSION = "0.1.0"`；建齐上列配置文件。
  - `AGENTS.md` 内容：项目一句话定位；目录地图；三层（内核 / 插件 / 外部应用）与依赖方向；多副本纪律原文（`ctx` 不给定时器、kv 必带 TTL、写读不在同一请求就不能用进程内状态）；迁移、配置、国际化（模型文案英文）规则各一句并指向 `skills/` 对应技能；「能自动检查的规则以检查为准」；常用命令。
  - `CLAUDE.md` 只有一行：`@AGENTS.md`。
  - `CONTRIBUTING.md`：开发环境（`docker compose -f docker/compose.dev.yaml up -d`）、提交规范（Conventional Commits）、changeset、CLA 说明（「代码始终以 Apache-2.0 开源」）。
  - CI：`pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm check` → `pnpm test`；PR 上额外跑 commitlint 校验提交信息。
  - `docker/compose.dev.yaml`：`postgres:17` 与 `valkey/valkey:8`，端口 5432 / 6379。
- [ ] **Step 4: 运行确认通过**：`pnpm lint && pnpm typecheck && pnpm test` → 全部 PASS。
- [ ] **Step 5: 提交** `chore: 初始化仓库骨架与 CI`。

### Task 2: 配置 schema、环境变量覆盖与文件来源

**Files:**
- Create: `packages/kernel/src/config/{schema,env,load,file-source}.ts`、`packages/kernel/test/config/load.test.ts`

**Interfaces:**
- Produces:
  - `meta(opts: { hot?: boolean; secret?: boolean; description: string })`：给 Zod 字段附加元信息（用 Zod 4 的 `.meta()`）。
  - `KernelConfigSchema`：至少包含
    - `db.url: string`（secret）、`db.poolMax: number` 默认 10
    - `redis.url: string`（secret）
    - `masterKey: string`（secret，base64，解码后 32 字节）；`masterKeyPrevious: string[]` 默认 `[]`（secret，轮换期间保留的旧主密钥）
    - `plugins: string[]` 默认 `[]`；`pluginConfig: Record<string, unknown>` 默认 `{}`（按插件名的部署级配置）
    - `http.port: number` 默认 8080
    - `roles: ("api"|"worker"|"gateway")[]` 默认 `["api","worker","gateway"]`
    - `log.level` 默认 `"info"`（hot）
  - `type KernelConfig = z.infer<typeof KernelConfigSchema>`
  - `interface ConfigSource { load(): Promise<unknown>; watch?(onChange: (raw: unknown) => void): () => void }`
  - `envOverrides(env: NodeJS.ProcessEnv): Record<string, unknown>`：`CAPYBARA_A__B_C=x` → `{ a: { bC: x } }`（段内 snake → camel；值尝试 JSON 解析，失败则当字符串）；忽略 `CAPYBARA_CONFIG_*` 与 `CAPYBARA_NACOS_*`。
  - `loadConfig(env: NodeJS.ProcessEnv): Promise<KernelConfig>`：选来源 → 深合并环境变量覆盖 → 校验；校验失败抛 `ConfigError`，`message` 列出每个出错的点路径。

- [ ] **Step 1: 写失败测试** `load.test.ts`：
  - `file source + env override`：临时 YAML 写 `http: { port: 9000 }`，env `CAPYBARA_HTTP__PORT=9100` → `config.http.port === 9100`。
  - `nested snake to camel`：`CAPYBARA_DB__POOL_MAX=20` → `config.db.poolMax === 20`。
  - `bad type names the key`：`CAPYBARA_DB__POOL_MAX=abc` → `rejects.toThrow(/db\.poolMax/)`。
  - `missing required names the key`：不给 `db.url` → `rejects.toThrow(/db\.url/)`。
  - `bad master key`：`masterKey` 解码后不是 32 字节 → `rejects.toThrow(/masterKey/)`。
  - `unknown source`：`CAPYBARA_CONFIG_SOURCE=consul` → `rejects.toThrow(/consul/)`。
- [ ] **Step 2: 运行确认失败**：`pnpm vitest run packages/kernel/test/config` → FAIL。
- [ ] **Step 3: 实现** 上述函数；YAML 解析用 `yaml` 包；`masterKey` 用 `.refine` 校验解码长度 32。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): 配置加载与环境变量覆盖`。

### Task 3: Nacos 配置来源

**Files:**
- Create: `packages/kernel/src/config/nacos-source.ts`、`packages/kernel/test/config/nacos-source.test.ts`
- Modify: `packages/kernel/src/config/load.ts`（接入 `nacos`）

**Interfaces:**
- Consumes: `ConfigSource`（Task 2）。
- Produces: `createNacosSource(opts: { server: string; namespace: string; dataId: string; group?: string /* 默认 DEFAULT_GROUP */; fetch?: typeof fetch }): ConfigSource`
  - `load()`：`GET {server}/nacos/v2/cs/config?dataId=&group=&namespaceId=`，响应 `data` 是 YAML 文本，解析后返回。
  - `watch(onChange)`：长轮询监听接口，变化时重新 `load()` 并回调；返回取消函数。
  - Nacos 不可达或返回非 200：`load()` 抛 `ConfigError`，信息含 server 与 dataId（启动快速失败，不用默认值）。

- [ ] **Step 1: 写失败测试**：用 `node:http` 在随机端口起一个 Nacos 桩。
  - `loads yaml from nacos`：桩返回 `{ code: 0, data: "http:\n  port: 9200\n" }` → `load()` 结果 `http.port === 9200`。
  - `unreachable fails fast`：指向未监听端口 → `rejects.toThrow(/capybara\.yaml/)`。
  - `watch fires on change`：桩第二次返回新内容 → 回调收到新值；调用取消函数后不再请求。
  - `loadConfig with nacos`：`CAPYBARA_CONFIG_SOURCE=nacos` + 桩 → 配置生效，且环境变量仍能覆盖。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（用全局 `fetch`；长轮询按 Nacos v2 监听接口，超时参数 30s）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): Nacos 配置来源`。

### Task 4: PG 连接与迁移器

**Files:**
- Create: `packages/kernel/src/db/{pool,migrator}.ts`、`packages/kernel/src/migrations/0001_init.sql`、`packages/testing/src/containers.ts`、`packages/kernel/test/db/migrator.test.ts`

**Interfaces:**
- Produces:
  - `createDb(url: string, poolMax: number): Kysely<any>`
  - `startTestPostgres(): Promise<{ url: string; stop(): Promise<void> }>`、`startTestRedis(): Promise<{ url: string; stop(): Promise<void> }>`（`@capybara-hq/testing`，Testcontainers）
  - `migrate(db: Kysely<any>, owner: { schema: string; dir: string }): Promise<{ applied: string[] }>`
    - 在目标 schema 下维护 `_migrations(name text primary key, checksum text not null, applied_at timestamptz not null default now())`。
    - 按文件名排序，跳过已执行；已执行文件的 checksum 变了 → 抛错并点名该文件。
    - 整个过程持有 **PG advisory lock**（键由 schema 名哈希得出），保证并发调用只有一个执行。
    - 每个文件在独立事务里执行。
  - `0001_init.sql`：`CREATE SCHEMA IF NOT EXISTS capybara;` 及 Task 9 用的 `capybara.org_data_keys(org_id text primary key, wrapped_key bytea not null, master_key_id text not null, created_at timestamptz not null default now())`。

- [ ] **Step 1: 写失败测试** `migrator.test.ts`（真实 PG 容器）：
  - `applies in order`：临时目录放 `0001_a.sql`、`0002_b.sql` → `applied` 依次为两者，表都存在。
  - `idempotent rerun`：再跑一次 → `applied` 为空。
  - `checksum mismatch`：改动 `0001_a.sql` 内容后再跑 → `rejects.toThrow(/0001_a\.sql/)`。
  - `concurrent migrate`：`Promise.all` 同时跑两次（两个独立 `Kysely` 实例）→ 两次的 `applied` 合计恰好各文件一次，且都不抛错。
  - `failed file rolls back`：`0003_bad.sql` 含语法错误 → 抛错，`_migrations` 中没有 0003，且 0003 中前面的语句也没生效。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（advisory lock 用 `pg_advisory_lock(hashtext($schema))`，结束 `pg_advisory_unlock`）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): PG 迁移器（advisory lock 防并发）`。

### Task 5: 迁移检查（证明会红）

**Files:**
- Create: `tools/checks/src/migrations.ts`、`tools/checks/fixtures/migrations/{bad-name,drop-column,no-if-not-exists,allowed-destructive}/`、`tools/checks/test/migrations.test.ts`
- Modify: 根 `package.json` 的 `check` 脚本

**Interfaces:**
- Produces: `checkMigrations(dirs: string[]): Finding[]`，`type Finding = { file: string; line: number; rule: string; message: string }`；CLI `pnpm check:migrations` 扫描 `packages/*/src/migrations` 与 `plugins/*/migrations`，有 finding 则 exit 1，每条输出 `file:line rule message`。
- 规则：
  - `naming`：文件名必须匹配 `^\d{4}_[a-z0-9_]+\.sql$`。
  - `idempotent`：`CREATE TABLE|INDEX|SCHEMA` 必须带 `IF NOT EXISTS`；`DROP ...` 必须带 `IF EXISTS`。
  - `destructive`：`DROP TABLE`、`DROP COLUMN`、`RENAME`、`ALTER COLUMN ... TYPE` 禁止，除非同一语句上一行有注释 `-- capybara:allow-destructive <原因>`（原因不能为空）。
  - 错误信息给出改法，例如 destructive：`先在本版本停止读写该列，下一版本再删除；确需本版本执行请加 -- capybara:allow-destructive <原因>`。

- [ ] **Step 1: 写失败测试**：每个违规 fixture 恰好产生对应 `rule` 的一条 finding（`bad-name`→`naming`、`drop-column`→`destructive`、`no-if-not-exists`→`idempotent`）；`allowed-destructive`（带注释与原因）→ 0 条；`packages/kernel/src/migrations` → 0 条。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（逐语句按 `;` 切分后正则匹配，忽略注释与字符串内文本）。
- [ ] **Step 4: 运行确认通过**；再手工把 `drop-column` fixture 复制进 `packages/kernel/src/migrations` 跑 `pnpm check:migrations` 确认 exit 1，然后删掉。
- [ ] **Step 5: 提交** `feat(checks): 迁移检查`。

### Task 6: plugin-sdk 类型与 `definePlugin`

**Files:**
- Create: `packages/plugin-sdk/src/{define-plugin,capability,ctx,secret}.ts`、`packages/plugin-sdk/test/define-plugin.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`

**Interfaces:**
- Produces（全部从 `@capybara-hq/plugin-sdk` 导出）：
  - `type CapabilityRef = \`${string}@${number}\``；`parseCapability(ref): { name: string; major: number }`
  - `type Cardinality = "single" | "multi"`；`CAPABILITY_CARDINALITY: Record<string, Cardinality>`，M0 登记 `sandbox`、`config-source`、`secret-store` 为 single，`channel`、`model-provider`、`identity-source`、`directory` 为 multi，另加测试用 `counter`（multi）。
  - `secret<T extends z.ZodTypeAny>(schema: T): T`（打 meta `{ secret: true }`）；`isSecret(schema): boolean`
  - `interface PluginManifest { name: string; version: string; sdk: string; provides: CapabilityRef[]; requires?: CapabilityRef[]; config?: { deployment?: z.ZodTypeAny; org?: z.ZodTypeAny }; migrations?: string; setup(ctx: PluginContext): void | Promise<void> }`
  - `definePlugin(m: PluginManifest): PluginManifest`：校验 `name` 匹配 `^[a-z][a-z0-9-]{1,40}$`、`version` 与 `sdk` 为合法 semver / range、`provides` 每项可解析且能力名已登记；不合法抛 `PluginManifestError`（信息含插件名与字段）。
  - `interface PluginContext`：
    - `kv: { get(key: string): Promise<string | null>; set(key: string, value: string, opts: { ttlSeconds: number }): Promise<void>; del(key: string): Promise<void>; incr(key: string, opts: { ttlSeconds: number }): Promise<number> }`
    - `lock: { acquire(key: string, opts: { ttlMs: number }): Promise<Lease | null> }`，`interface Lease { renew(): Promise<boolean>; release(): Promise<void> }`
    - `bus: { publish(topic: string, payload: unknown): Promise<void>; subscribe(topic: string, handler: (payload: unknown) => void): Promise<() => Promise<void>> }`
    - `queue: { define<T>(name: string, handler: (data: T) => Promise<void>, opts?: { concurrency?: number }): void; add<T>(name: string, data: T, opts?: { delayMs?: number; jobId?: string }): Promise<void> }`
    - `secrets: { get(orgId: string, key: string): Promise<string | null>; set(orgId: string, key: string, value: string): Promise<void> }`
    - `db: Kysely<any>`（已切到本插件 schema 的 `withSchema`）
    - `http: { route(method: "GET"|"POST"|"PUT"|"DELETE", path: string, handler: (req: Request) => Promise<Response>): void }`（实际挂载到 `/plugins/<name><path>`）
    - `provide(capability: CapabilityRef, impl: unknown): void`
    - `config: unknown`（部署级配置，已按插件 schema 校验）
    - `log: { info/warn/error(msg: string, fields?: object): void }`
  - `ctx.tools` 与 `ctx.hooks` 在 M2 / M3 加入，M0 不导出。

- [ ] **Step 1: 写失败测试** `define-plugin.test.ts`：
  - 合法清单原样返回。
  - `name: "Bad_Name"` → `toThrow(/name/)`；`provides: ["nope@1"]` → `toThrow(/nope/)`；`sdk: "not-semver"` → `toThrow(/sdk/)`。
  - `isSecret(secret(z.string()))` 为 true，`isSecret(z.string())` 为 false。
  - `parseCapability("channel@1")` 等于 `{ name: "channel", major: 1 }`；`parseCapability("channel")` 抛错。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（semver 校验用 `semver` 包）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(plugin-sdk): definePlugin 与 ctx 类型`。

### Task 7: `ctx.kv` 与 `ctx.lock`

**Files:**
- Create: `packages/kernel/src/ctx/{kv,lock}.ts`、`packages/kernel/test/ctx/{kv,lock}.test.ts`

**Interfaces:**
- Consumes: `PluginContext["kv"|"lock"]` 类型（Task 6），`startTestRedis`（Task 4）。
- Produces:
  - `createKv(redis: Redis, namespace: string): PluginContext["kv"]`：实际键为 `cap:<namespace>:<key>`；`ttlSeconds` 缺失或 ≤ 0 抛 `TypeError(/ttlSeconds/)`；`incr` 首次创建时设置 TTL。
  - `createLock(redis: Redis, namespace: string): PluginContext["lock"]`：`SET key token NX PX ttl`；`release` 与 `renew` 用 Lua 脚本校验 token，只操作自己持有的锁。

- [ ] **Step 1: 写失败测试**（真实 Valkey 容器）：
  - kv：`set` 后 `get` 取回；`set` 不带 TTL → 抛 `/ttlSeconds/`；`ttlSeconds: 1` 等 1.5s 后 `get` 为 null；两个不同 namespace 同名键互不可见。
  - lock：A 拿到后 B `acquire` 返回 null；A `release` 后 B 能拿到；A 拿锁（`ttlMs: 500`）后不释放，600ms 后 B 能拿到（模拟崩溃）；之后 A 调 `release` **不会**释放 B 的锁（B 仍持有）；`renew` 在过期前返回 true 并延长。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): ctx.kv 与 ctx.lock`。

### Task 8: `ctx.bus` 与 `ctx.queue`

**Files:**
- Create: `packages/kernel/src/ctx/{bus,queue}.ts`、`packages/kernel/test/ctx/{bus,queue}.test.ts`

**Interfaces:**
- Produces:
  - `createBus(pub: Redis, subFactory: () => Redis, namespace: string): PluginContext["bus"]`：频道 `cap:<namespace>:<topic>`；payload JSON 序列化；一个进程共用一条订阅连接。
  - `createQueue(redisUrl: string, namespace: string, opts: { runWorkers: boolean }): PluginContext["queue"] & { close(): Promise<void> }`：BullMQ 队列名 `cap-<namespace>-<name>`；`name`、`jobId` 含 `:` 时抛 `TypeError`（提示改用 `-`）；`runWorkers` 为 false 时 `define` 只登记不创建 `Worker`（调用方按进程是否含 worker 角色传入）；`close` 等待进行中的任务。

- [ ] **Step 1: 写失败测试**：
  - bus：两个独立 `createBus` 实例（模拟两个副本），A `publish`，B 的 handler 收到相同 payload；取消订阅后不再收到。
  - queue：`define` + `add` → handler 收到数据；`delayMs: 500` 时 400ms 内未执行、1s 内执行；同 `jobId` 重复 `add` 只执行一次；`name` 含 `:` → 抛 `TypeError`；`runWorkers: false` 时 `add` 成功但不执行。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): ctx.bus 与 ctx.queue`。

### Task 9: `ctx.secrets`（信封加密）

**Files:**
- Create: `packages/kernel/src/ctx/secrets.ts`、`packages/kernel/test/ctx/secrets.test.ts`；迁移 `packages/kernel/src/migrations/0002_secrets.sql`：`capybara.secrets(namespace text, org_id text, key text, ciphertext bytea not null, updated_at timestamptz not null default now(), primary key(namespace, org_id, key))`

**Interfaces:**
- Produces:
  - `createKeyring(current: Buffer, previous: Buffer[]): Keyring`：每把主密钥的 id 为其 SHA-256 前 8 字节的 hex；`current` 用于新包装，`previous` 只用于解包。来源是配置的 `masterKey` 与 `masterKeyPrevious`。
  - `createSecrets(db: Kysely<any>, keyring: Keyring, namespace: string): PluginContext["secrets"]`：每个组织一把 32 字节数据密钥，首次使用时生成，用当前主密钥 AES-256-GCM 包装后存 `capybara.org_data_keys`；值用数据密钥 AES-256-GCM 加密，密文格式 `iv(12) | tag(16) | data`。
  - `rewrapDataKeys(db, keyring): Promise<number>`：把 `master_key_id` 不是当前主密钥的数据密钥改用当前主密钥重新包装，返回处理条数；某条的主密钥 id 在 keyring 中找不到 → 抛错点名该 `org_id`。

- [ ] **Step 1: 写失败测试**（真实 PG）：
  - `set` 后 `get` 取回原文；库里 `ciphertext` 不含原文字节。
  - 不同 org 的数据密钥不同；`get` 不存在的键返回 null。
  - 密文被篡改一个字节 → `get` 抛错（GCM 校验失败），不返回乱码。
  - 轮换：用 `createKeyring(新, [旧])` 后旧值仍能读；`rewrapDataKeys` 返回 > 0；之后用 `createKeyring(新, [])` 也能读旧值。
  - 缺失主密钥：用 `createKeyring(另一把, [])` 读旧值 → 抛错且信息含 `master key`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（`node:crypto`）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): ctx.secrets 信封加密与主密钥轮换`。

### Task 10: 插件宿主

**Files:**
- Create: `packages/kernel/src/plugins/{resolve,host}.ts`、`packages/kernel/src/ctx/create-ctx.ts`、`packages/kernel/test/plugins/{resolve,host}.test.ts`、测试用插件 `packages/kernel/test/fixtures/plugins/*`

**Interfaces:**
- Consumes: Task 4、6–9 的全部产物。
- Produces:
  - `resolvePlugins(manifests: PluginManifest[], sdkVersion: string): PluginManifest[]`：返回按 `requires` 拓扑排序后的列表。报错（`PluginResolveError`，信息列出插件名与能力名）的情况：`sdk` 范围不满足当前 `SDK_VERSION`；`requires` 的能力无人提供；循环依赖；单选能力被多个插件提供。
  - `interface KernelDeps { db: Kysely<any>; redis: Redis; redisSubFactory: () => Redis; redisUrl: string; keyring: Keyring; runWorkers: boolean; log: Logger }`
  - `type Route = { method: "GET"|"POST"|"PUT"|"DELETE"; path: string; handler: (req: Request) => Promise<Response> }`（`path` 已含 `/plugins/<name>` 前缀）
  - `createPluginContext(deps: KernelDeps, manifest: PluginManifest, deploymentConfig: unknown): PluginContext & { routes: Route[]; provided: Map<CapabilityRef, unknown> }`：各服务的 namespace 即插件名；`db` 切到 `plugin_<name>`。
  - `class PluginHost`：
    - `load(specifiers: string[]): Promise<void>`：`import()` 每个模块的 default 导出 → `resolvePlugins` → 依次：按插件 `config.deployment` schema 校验 `pluginConfig[name]`（失败点名插件与字段）→ 若有 `migrations` 则 `migrate(db, { schema: "plugin_<name>", dir })` → `setup(ctx)`。
    - `get<T>(capability: CapabilityRef, providerName?: string): T`：单选能力不传 name；多选能力必须传。
    - `list(capabilityName: string): { plugin: string; impl: unknown }[]`
    - `routes(): Route[]`
- [ ] **Step 1: 写失败测试**：
  - resolve：A requires `counter@1`、B provides `counter@1` → 顺序为 [B, A]；缺提供方 → `/counter@1/` 与 `/A/`；两个插件都提供 `sandbox@1` → 两个插件名都出现在信息里；`sdk: "^9.0.0"` → `/sdk/`；循环 → `/cycle/i`。
  - host：fixture 插件带迁移与 `provide("counter@1", impl)` → `load` 后 `get("counter@1", "fixture")` 返回 impl，`plugin_fixture` schema 中的表存在；部署配置不合法 → 抛错点名插件与字段；插件 `setup` 抛错 → `load` 抛错并带插件名。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): 插件宿主`。

### Task 11: HTTP、角色与内核生命周期、CLI

**Files:**
- Create: `packages/kernel/src/http/{app,health}.ts`、`packages/kernel/src/kernel.ts`、`apps/capybara/src/{cli,commands/start,commands/migrate}.ts`、`packages/kernel/test/kernel.test.ts`

**Interfaces:**
- Produces:
  - `createKernel(config: KernelConfig): Promise<Kernel>`；`interface Kernel { app: Hono; host: PluginHost; start(): Promise<void>; stop(): Promise<void> }`
    - `start`：连接 PG / Redis → 运行内核迁移（`capybara` schema）→ `host.load(config.plugins)` → 角色含 `api` 或 `gateway` 时监听 `http.port`。
    - 路由：`GET /healthz` 恒 200 `{ ok: true }`；`GET /readyz` 检查 PG（`select 1`）与 Redis（`PING`），任一失败返回 503 并在 body 里标出哪一个；插件路由挂在 `/plugins/<name>/*`，插件不能注册此前缀以外的路径。
    - 配置热更新：若配置来源提供 `watch`，变化时重新校验；只把标记为 `hot` 的字段应用到运行中的内核（M0 只有 `log.level`），其余字段变化记一条 warn，列出需要重启才生效的键名；校验失败则保留原配置并记 error。
    - `stop`：先让 `/readyz` 返回 503，停止 HTTP 接收新连接，关闭队列 worker（等待进行中的任务，最长 30s），最后关闭 PG / Redis。SIGTERM / SIGINT 触发 `stop`。
  - CLI：`capybara start [--role api,worker,gateway]`（覆盖 `roles`）；`capybara migrate`（只跑内核与所有已配置插件的迁移然后退出，退出码 0 / 1）。
- [ ] **Step 1: 写失败测试**（真实 PG / Redis，用 `app.request()` 不实际监听端口）：
  - `/healthz` 200；`/readyz` 200 且 body 含 `pg: "ok"`、`redis: "ok"`。
  - 关闭 Redis 容器后 `/readyz` 503，body 标出 `redis`。
  - fixture 插件注册 `GET /hello` → `GET /plugins/fixture/hello` 200；直接 `GET /hello` 404。
  - 调用 `stop()` 后 `/readyz` 立即 503。
  - 热更新：用可手动触发的假配置来源，推送 `log.level: "debug"` → 内核日志级别变为 debug；推送 `http.port` 变化 → 端口不变，且有一条 warn 含 `http.port`；推送非法配置 → 原配置保持。
  - `roles: ["worker"]` 时 `start()` 不监听端口，但队列 handler 能执行。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**；手工：`docker compose -f docker/compose.dev.yaml up -d` 后 `pnpm --filter @capybara-hq/capybara exec capybara migrate` 退出码 0。
- [ ] **Step 5: 提交** `feat(kernel): HTTP、角色、生命周期与 CLI`。

### Task 12: 双副本测试工具（证明会红）

**Files:**
- Create: `packages/testing/src/dual-replica.ts`、`packages/testing/test/dual-replica.test.ts`、`packages/testing/test/fixtures/{leaky-counter,good-counter}/index.ts`

**Interfaces:**
- Consumes: `createKernel`（Task 11）、`startTestPostgres` / `startTestRedis`（Task 4）。
- Produces: `createDualReplicaHarness(opts: { plugins: string[]; pluginConfig?: Record<string, unknown> }): Promise<Harness>`
  - `interface Harness { request(path: string, init?: RequestInit): Promise<Response>; replicas: [Kernel, Kernel]; stop(): Promise<void> }`
  - 两个内核实例共享同一套 PG / Redis 容器，`masterKey` 相同；`request` 严格交替发往两个实例（第 1、3、5… 次到 replica 0）。
  - 两个实例的 `roles` 都包含 worker，队列任务可能落在任一实例。
- fixture：
  - `leaky-counter`：`POST /plugins/leaky-counter/inc` 用**模块级 `Map`** 计数，`GET /count` 读它。
  - `good-counter`：同样两个路由，用 `ctx.kv.incr`（TTL 3600）。
- [ ] **Step 1: 写失败测试**：同一场景「调用 `inc` 4 次后 `GET /count` 应为 4」：
  - `good-counter` → 通过（count 为 4）。
  - `leaky-counter` → 断言 **count 不等于 4**（证明工具能把进程内状态暴露出来）。
- [ ] **Step 2: 运行确认失败**（harness 未实现）。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(testing): 双副本测试工具`。

### Task 13: 插件边界检查与配置文档检查（证明会红）

**Files:**
- Create: `tools/checks/src/{deps,plugin-state,config-docs}.ts`、`packages/kernel/src/config/docs.ts`、`docs/config.md`（生成）、`tools/checks/fixtures/{plugin-imports-kernel,plugin-module-state,plugin-timer}/`、`tools/checks/test/{deps,plugin-state,config-docs}.test.ts`
- Modify: 根 `package.json`：`check` = `check:migrations && check:deps && check:plugin-state && check:config-docs`；新增 `gen:config-docs`

**Interfaces:**
- Produces:
  - `checkDeps(pluginDirs: string[]): Finding[]`：插件源码（含 `package.json` 依赖）出现 `@capybara-hq/kernel` 或其他 `@capybara-hq/*`（除 `plugin-sdk`）→ `rule: "plugin-imports-kernel"`；`packages/plugin-sdk` import 任何 `@capybara-hq/*` → `rule: "sdk-imports-internal"`。
  - `checkPluginState(pluginDirs: string[]): Finding[]`（TypeScript 编译器 API 解析 AST）：
    - `plugin-timer`：调用 `setTimeout`、`setInterval`、`setImmediate`；
    - `plugin-module-state`：模块顶层的 `let` / `var` 声明；或模块顶层的 `const`，其初始化表达式是 `new Map(…)`、`new Set(…)`、`new WeakMap(…)` 或数组字面量；
    - 行内注释 `// capybara:allow-module-state <原因>` 豁免该行（原因不能为空）。
    - 报错信息给出改法：`改用 ctx.kv / ctx.queue（延迟任务）/ ctx.bus`。
  - `renderConfigDocs(schema: z.ZodTypeAny): string`：每个配置项一行：点路径、对应环境变量名、类型、默认值、是否可热更、是否密钥、说明；`pnpm gen:config-docs` 写入 `docs/config.md`。
  - `checkConfigDocs(): Finding[]`：重新渲染与 `docs/config.md` 不一致 → `rule: "config-docs-stale"`，提示运行 `pnpm gen:config-docs`。
- [ ] **Step 1: 写失败测试**：三个违规 fixture 各产生对应 rule 的 finding；`plugins/example-counter`（Task 14）与 `packages/testing/test/fixtures/good-counter` → 0 条；`leaky-counter` 至少 1 条 `plugin-module-state`；`renderConfigDocs` 输出包含 `CAPYBARA_DB__POOL_MAX` 与 `db.poolMax`；向 `KernelConfigSchema` 的测试副本加字段后 `checkConfigDocs` 报 `config-docs-stale`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**；`pnpm gen:config-docs && pnpm check` 全绿。
- [ ] **Step 5: 提交** `feat(checks): 插件边界、插件状态与配置文档检查`。

### Task 14: 示例插件、开发技能与端到端验收

**Files:**
- Create: `plugins/example-counter/{package.json,src/index.ts,migrations/0001_init.sql,test/counter.test.ts}`
- Create: `skills/writing-plugins/SKILL.md`、`skills/writing-migrations/SKILL.md`、`skills/adding-config/SKILL.md`
- Modify: `README.md`（快速开始）、`AGENTS.md`（链接三个技能）

**Interfaces:**
- Consumes: `definePlugin`、`PluginContext`（Task 6）、`createDualReplicaHarness`（Task 12）。
- Produces: 插件 `@capybara-hq/plugin-example-counter`（name `example-counter`）：
  - 部署级配置 `{ step: number }` 默认 1；
  - `POST /plugins/example-counter/inc`：`ctx.kv.incr`（TTL 86400）并把每次递增记一行到 `plugin_example_counter.events(id bigserial primary key, at timestamptz default now())`；
  - `GET /count` 返回 `{ count }`；
  - `POST /inc-later`：`ctx.queue.add("delayed-inc", {}, { delayMs: 200 })`，handler 执行递增；
  - `provide("counter@1", { get(): Promise<number> })`。
- [ ] **Step 1: 写失败测试** `counter.test.ts`（用双副本工具）：
  - 交替 `inc` 5 次 → `count === 5`，`events` 表 5 行。
  - `step: 2` 时 `inc` 3 次 → `count === 6`。
  - `inc-later` 后 1s 内 `count` 增加 1（任务可能在任一副本执行）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现插件**；写三个技能：
  - `writing-plugins`：清单字段、两级配置、`ctx` 每项何时用、禁止事项（定时器、模块级状态）与替代、用双副本工具写测试的模板。
  - `writing-migrations`：命名、幂等写法、扩展→收缩两步的示例（加列 → 下个版本删旧列）、豁免注释的用法与「原因」要求、本地如何运行 `capybara migrate`。
  - `adding-config`：在 `KernelConfigSchema` 加字段并写 `meta`（hot / secret / description）、对应环境变量名的推导、运行 `pnpm gen:config-docs`。
  - 每个技能 frontmatter 含 `name` 与说明何时使用的 `description`。
- [ ] **Step 4: 运行确认通过**；全量 `pnpm lint && pnpm typecheck && pnpm check && pnpm test` 全绿；README 快速开始的命令逐条手工执行一遍。
- [ ] **Step 5: 提交** `feat: 示例插件与开发技能` 并添加一个 changeset（`@capybara-hq/plugin-sdk`、`@capybara-hq/kernel` minor）。
