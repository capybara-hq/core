---
name: writing-plugins
description: 在 plugins/* 下新建或修改 Capybara 插件时使用：清单字段、两级配置、ctx 各项的用法、多副本下禁止的写法（定时器、模块级状态）及替代方案，以及用双副本工具写测试的模板。
---

# 写插件

参考实现：`plugins/example-counter`（db 事务 + queue 幂等任务 + provide，直接复制它起步；kv 的用法见下文「持久计数与幂等的写法」）。

## 硬约束（先看这个）

| 规则 | 检查 | 规则 id |
|---|---|---|
| 只能 import `@capybara-hq/plugin-sdk`、`zod`、其他第三方 npm 包；**不能** import `@capybara-hq/kernel` 或插件目录之外的文件。测试里可以用 devDependency `@capybara-hq/testing` | `pnpm check:deps` | `plugin-imports-kernel`、`plugin-imports-outside` |
| 不得使用 `setTimeout` / `setInterval` / `setImmediate` / `node:timers` | `pnpm check:plugin-state` | `plugin-timer` |
| 模块顶层不得有 `let` / `var` / `new Map/Set/WeakMap/WeakSet` / 数组字面量 | `pnpm check:plugin-state` | `plugin-module-state` |
| `ctx.kv` 写入必须带 `ttlSeconds`（类型层强制） | `pnpm typecheck` | — |
| 队列名、job id 不含 `:`（BullMQ 限制） | 运行时：`ctx.queue.define` / `add` 直接抛 `TypeError` | — |

`pnpm check` 一次跑全部。

### 为什么禁定时器与模块级状态

生产是多副本，写入方和读取方可能不在同一个进程。进程内的 Map / 定时器只存在于创建它的那个进程：别的副本读不到、停不掉。dev 单进程测不出来，所以要在写代码时就避开。

| 想做的事 | 别这样 | 这样 |
|---|---|---|
| 跨请求共享状态 | 模块顶层 `Map` | 持久数据 `ctx.db`；临时/会过期的状态 `ctx.kv`（带 TTL） |
| 延迟 / 周期任务 | `setTimeout` / `setInterval` | `ctx.queue.add(name, data, { delayMs })` |
| 通知其他副本 | 进程内事件 / 回调表 | `ctx.bus.publish` / `subscribe` |
| 「谁开谁关」的配对 | 开启方在内存里持有句柄 | 开启方自过期（TTL）+ 关闭方广播 |

确属只读常量（如正则表、固定查找表）才豁免：在声明**同一行行尾**或**紧邻上一行**写 `// capybara:allow-module-state <原因>`，原因不能为空（空原因仍报 `plugin-module-state`）。

## 清单（definePlugin）

```ts
import { definePlugin } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

export default definePlugin({
  name: "my-plugin",          // ^[a-z][a-z0-9-]{1,40}$，保留名 kernel 不可用；PG schema 为 plugin_my_plugin
  version: "0.1.0",           // semver
  sdk: "^0.1.0",              // 兼容的 SDK 版本范围
  provides: ["counter@1"],    // 提供的能力，形如 名称@主版本，须是 SDK 已登记的能力
  requires: [],               // 依赖的其他插件能力（可选；不能与 provides 重复）
  config: {
    deployment: z.object({ step: z.number().int().positive().default(1) }), // 部署级
    // org: z.object({...}),                                                // 组织级
  },
  migrations: "../migrations", // 相对入口文件所在目录；src/ 与 dist/ 下都指向包根 migrations/
  setup(ctx) { /* 见下 */ },
});
```

`definePlugin` 在加载时校验清单，不合法直接抛错。

`sdk` 范围由内核按 `SDK_VERSION`（等于 `@capybara-hq/plugin-sdk` 的 package 版本，有测试钉住）校验。0.x 阶段 `^0.1.0` 只匹配 `0.1.x`：**SDK 升 minor（如 0.2.0）时，仓库内所有插件的 `sdk` 范围都要同步改**，否则内核拒绝加载。

## 两级配置

- **部署级**（`config.deployment`）：运维在内核配置的 `pluginConfig.<插件名>` 里给（环境变量 `CAPYBARA_PLUGIN_CONFIG` 传 JSON，或逐字段 `CAPYBARA_PLUGIN_CONFIG__<插件名大写、- 换 _>__<字段>`，如 `CAPYBARA_PLUGIN_CONFIG__EXAMPLE_COUNTER__POOL_SIZE=3` 对应 `example-counter` 的 `poolSize`）。标了 `secret` 的部署级字段，其值校验通过后自动加入日志打码集合。内核启动时按 schema 校验，`ctx.config` 是校验后的值；类型是 `unknown`，在 `setup` 里用同一个 schema `parse` 一次拿到类型。
- **组织级**（`config.org`）：每个组织各自的启用状态与配置，由组织 admin 通过内核 API（`GET /api/v1/orgs/:orgId/plugins`、`PUT /api/v1/orgs/:orgId/plugins/:plugin`）设置，内核按该 schema 校验并存储，规则见下一节。
- 插件自己运行中产生的密钥（如 OAuth 换来的 token）走 `ctx.secrets`（加密存储），不要放进普通配置。

### 组织级配置与 `secret()` 字段的存储与回显

- 敏感字段用 `secret(schema)` 标记（`import { secret } from "@capybara-hq/plugin-sdk"`）。内核用 `configFields` 遍历 `config.org`，`meta.secret` 为真的叶子按点路径（如 `webhook.token`）识别为密钥字段。对象上标 `secret` 对其全部后代叶子生效。
- **只支持对象路径**：`secret()` 只能标在从根经对象字段（及 `default` / `prefault` / `optional` / `nullable` / `readonly` / `catch` 包装）可达的节点上。标在 union / discriminatedUnion / intersection / transform / pipe / lazy / 数组元素 / record 值 / tuple 等内部的 `secret()`（`config.org` 与 `config.deployment` 都算）会让**插件加载失败**，错误点名插件与路径（如 `plugin x: config.org: secret() at "auth<union#1>.token" ...`）。需要时把外层整个对象字段（或整个数组字段）标 `secret`，它的值作为一个整体加密存储。
- 存储：非密钥部分（校验后的值，含默认值）存 `capybara.plugin_org_configs.config`；每个密钥字段单独加密存 `capybara.secrets`（命名空间 `kernel`、键 `plugin-config:<插件名>:<点路径>`，值为 JSON 编码），与配置行在同一事务内写入。`kernel` 因此是保留插件名。
- 回显：API 响应的 `config` 永远不含密钥字段，只给 `secrets: [{ path, set }]` 表示是否已设置；审计只记 `{ enabled, changedPaths }`。
- 更新（`PUT` 的 `config`）：非密钥字段整体替换为传入值；密钥字段**缺省 = 保留原值**、`null` = 清除、其他值 = 新值。合并后的完整对象再用 schema 校验，失败返回 `plugin.config_invalid`，`details` 为 `{ path, message }[]`（不回显值）。只传 `enabled: true` 时也会校验现存配置，不满足 schema 不能启用。
- 读取：内核 `orgPluginConfigs.get(orgId, plugin)` 解密并校验后返回完整配置。**升级插件时改 org schema 要兼容旧值**（新字段给默认值或 optional）：已存配置不再满足新 schema 时 `get` 直接抛错，需要组织 admin 重新保存配置。

## ctx 各项何时用

| 项 | 用途 | 要点 |
|---|---|---|
| `ctx.kv` | **临时、会过期**的状态：限流计数、短缓存、幂等键 | `set` / `incr` 必须带 `{ ttlSeconds }`；`incr` 每次只加 1，没有 `incrBy`。**持久数据（业务计数、账务）不要放 kv**：TTL 一到就没了，且与 db 双写无法保证一致 |
| `ctx.db` | 持久数据 | Kysely，已切到本插件 schema，写表名**不带** schema 前缀；表由 `migrations/` 建，见 `skills/writing-migrations`。**注意**：原始 SQL `` sql`...`.execute(ctx.db) `` 不经过 `withSchema`，会落到连接默认的 search_path（`public`）——要么用查询构建器，要么在 SQL 里写全 `plugin_<name>.<表>` |
| `ctx.queue` | 延迟 / 异步 / 周期任务 | `define(name, handler)` 在 `setup` 里注册；`add(name, data, { delayMs, jobId })`；任务可能在任一副本执行，投递是**至少一次**（失败重试，最多 3 次），handler 必须幂等（见下）；名称与 jobId 不含 `:` |
| `ctx.lock` | 互斥 | `acquire(key, { ttlMs })` 返回租约或 `null`；长任务要 `renew()`，用完 `release()` |
| `ctx.bus` | 跨副本广播 | `publish` / `subscribe`，订阅返回取消函数；消息可能丢，别当唯一的结束信号 |
| `ctx.http.route` | 对外接口 | 实际挂在 `/plugins/<name><path>`；匹配与 body 语义见下节，不经内核鉴权 |
| `ctx.provide` | 对外暴露能力实现 | 要与清单 `provides` 一致 |
| `ctx.secrets` | 按组织存取密钥 | 加密落库 |
| `ctx.config` / `ctx.log` | 部署配置 / 日志 | 日志里不要打印密钥 |

### 插件路由的匹配语义（`ctx.http.route`）

签名固定：`ctx.http.route(method, path, (req: Request) => Promise<Response>)`，插件**不依赖 Nest**、不写 controller。内核在 Fastify 的独立封装作用域里收下 `/plugins/*`，再转成 Web `Request` 交给你：

- **路径语法与 Fastify 相同**（find-my-way）：`path` 相对插件前缀，如 `route("GET", "/items/:id", …)` 匹配 `/plugins/<name>/items/42`；也支持通配 `*`。匹配只看路径，不含查询串。
- **handler 只收到 Web `Request`，拿不到解析好的路径参数**：自己从 `new URL(req.url).pathname` 里取（查询串用 `new URL(req.url).searchParams`）。
- **body 是原始字节**：作用域内不做 JSON / 表单解析，任何 content-type 都原样转交，`await req.text()` / `req.json()` / `req.arrayBuffer()` 自己解析（webhook 验签可直接用原始字节）。GET / HEAD 不带 body。
- **请求体上限 1 MiB**（Fastify 默认 bodyLimit），超出直接 413（Fastify 原生错误体 `FST_ERR_CTP_BODY_TOO_LARGE`，不是内核错误信封），到不了 handler。
- **HEAD 不会自动映射到 GET**：只注册了 GET 时 HEAD 请求是 404；需要 HEAD 就显式再注册一条。
- 尾斜杠敏感：`/count` 与 `/count/` 是两条路由。
- 未匹配 → 404 `not_found`；handler 抛错 → 500 `internal`（错误记日志，不回显给客户端）。
- **插件路由不经内核鉴权**：没有 AuthGuard、不检查 CSRF 头、拿不到调用者身份（M4 再提供）。对外暴露的 webhook 必须自行验签。
- 响应的 status、头（含多条 `set-cookie`）原样回给客户端，body 支持流式。

### 持久计数与幂等的写法（参考 example-counter）

- 持久计数放 `ctx.db`，一次请求里的多步改动包在一个事务里：`ctx.db.transaction().execute(async (trx) => { ... })`。需要「一次加 N」的原子计数用 SQL（`n = n + N`），不要循环 `kv.incr`。
- kv 的合理用法（带 TTL）：

  ```ts
  await ctx.kv.set(`seen:${eventId}`, "1", { ttlSeconds: 600 }); // 短期幂等键 / 限流 / 短缓存
  ```

- 队列 handler 幂等：入队时生成 `jobId`（`crypto.randomUUID()`，不含 `:`）同时放进数据与 `opts.jobId`；表上给 `job_id` 加唯一约束；handler 在一个事务里 `INSERT ... ON CONFLICT (job_id) DO NOTHING RETURNING id`，**只有真的插入了才做业务副作用**，重复投递就什么都不做。

任何「靠某个信号来结束」的持续性副作用都要有最大存活时间（TTL），到点自己了断。

## 测试模板（双副本）

用 `@capybara-hq/testing` 的 `createDualReplicaHarness`：两个**独立子进程**副本，请求严格交替（第 1、3、5… 次到 replica 0）。凡是把状态放进了进程内存，这里必然测红。

```ts
import { fileURLToPath } from "node:url";
import { createDualReplicaHarness, type Harness, startTestPostgres } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

const PLUGIN = fileURLToPath(new URL("../src/index.ts", import.meta.url));
let pgc: Awaited<ReturnType<typeof startTestPostgres>>;
const harnesses: Harness[] = [];

beforeAll(async () => { pgc = await startTestPostgres(); });
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.stop())); });
afterAll(async () => { await pgc?.stop(); });

it("交替请求两个副本，结果一致", async () => {
  const h = await createDualReplicaHarness({
    plugins: [PLUGIN],
    pgUrl: pgc.url,
    pluginConfig: { "my-plugin": { step: 2 } }, // 可选：部署级配置
  });
  harnesses.push(h);
  for (let i = 0; i < 5; i++) await h.request("/plugins/my-plugin/inc", { method: "POST" });
  const r = await h.request("/plugins/my-plugin/count");
  expect(((await r.json()) as { count: number }).count).toBe(10);
});
```

要点：`config` 选项可把额外的内核配置深合并进两个副本（如 `config: { auth: { cookieSecure: false } }`，经 IPC 传递）；每个 harness 自带一个 Redis 容器，用完 `stop()`；传入 `pgUrl`（管理员连接串）可让多个 harness 复用同一个 PG 容器；队列任务异步执行，断言时轮询等到期望值，不要只 `sleep` 固定时长；测试文件放在插件根的 `test/` 目录（`pnpm test` 会收集）。

## 新插件清单

1. 复制 `plugins/example-counter`，改包名 `@capybara-hq/plugin-<name>`、`name`、PG 表。
2. 在根 `tsconfig.json` 的 `references` 加一项。
3. 迁移按 `skills/writing-migrations` 写。
4. `pnpm lint && pnpm typecheck && pnpm check && pnpm test`。
5. 影响发布的改动加 changeset（`pnpm changeset`）。
