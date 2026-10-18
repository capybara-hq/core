# M2 Agent 运行时 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 agent 运行时：Agent 定义与版本、会话事件日志、BullMQ 运行链路、LangGraph 默认 loop、流式广播、插话、中止、崩溃续跑、上下文压缩、`anthropic` / `openai` 供应商插件与一致性测试、最小网页聊天；并清掉 M1 遗留事项（含 R24、R25、Nacos 鉴权），使「网页里和 agent 多轮对话，杀掉 worker 后自动续跑」在双副本下跑通。

**Architecture:**
- **事实源**：会话事件日志（PG，只追加）是唯一事实源；LangGraph checkpoint 只用于续跑。checkpointer 由内核基于 Kysely 自己实现，表结构走纯 SQL 迁移。
- **运行链路**：一轮运行 = BullMQ 任务（`cap-kernel-runs`），由任意 worker 领取。
- **多副本状态**：会话级 Redis 租约锁保证同一会话同时只跑一轮；组织并发配额用带过期时间的 Redis ZSET 计数；中止信号经 Redis 键加广播传递；流式增量经 Redis 频道推给持有 SSE 连接的 api 副本。
- **管线阶段**：上下文构建、压缩、配对守卫、尾部提醒、token 估算都是纯函数阶段，各自单独测试。
- **模型调用**：经 `model-provider@1` 能力接口，供应商插件各用官方 SDK 走原生协议；内核不含任何模型或网关特定的补丁。
- **前端**：网页聊天是独立的 Next 应用（`apps/web`），通过 `/api` 代理访问内核。

**Tech Stack:**
- 编排与 checkpoint：`@langchain/langgraph` 1.5、`@langchain/langgraph-checkpoint` 1.2（自实现 saver）、`@langchain/langgraph-checkpoint-validation` 1.2（校验）。
- 供应商 SDK：`@anthropic-ai/sdk`、`openai`（Responses API）。
- 前端：Next 16 + React 19 + `next-intl`。
- 测试：Vitest + Testcontainers；网页端用 Testing Library 加 Playwright。

**Spec:** `docs/superpowers/specs/2026-10-17-capybara-architecture-design.md`（重点 2.1、2.3、3.4、3.6 R1/R5、4、6、8.4–8.6、10、13.3）

**参考：**
- 路线图：`docs/superpowers/plans/2026-10-17-mvp-roadmap.md`
- 运行时可靠性经验：`docs/research/agent-runtime-reliability.md`
- 遗留事项：`docs/superpowers/plans/2026-10-17-m1-followups.md`、`docs/superpowers/plans/2026-10-17-m0-followups.md`
- M1 计划（格式参照）：`docs/superpowers/plans/2026-10-17-m1-identity.md`

## Global Constraints

### 依赖与分层
- 包名一律 `@capybara-hq/<name>`；许可证 Apache-2.0；依赖装当时最新稳定版。
- 插件只能 import `@capybara-hq/plugin-sdk` 与第三方 npm 包；`@capybara-hq/testing` 只能出现在插件的测试与 devDependencies 中。

### 多副本纪律
- 写入方与读取方可能不在同一进程的状态不得放进程内存，用 PG / Redis。
- 每个 Redis 写入都带 TTL。
- 内核 Redis 键前缀为 `capk:`。
- BullMQ 队列名与 job id 不得含 `:`。
- 内核进程内的定时器只允许用于「本进程持有的资源」：本进程持有的锁的续租、本进程持有的 SSE 连接的心跳、本进程发起的模型调用的看门狗。

### 内核 HTTP
- 领域类不依赖 Nest，用 `useFactory` 注入。
- 构造参数显式 `@Inject`。
- 默认拒绝；新增公开路由必须同时改 `public-routes.test.ts` 的清单。
- 组织写操作用 `lockOrgAndAuthorize`，在组织行锁内重读操作者角色（spec 3.6 R5）。
- 错误码登记在 `errors.ts`，`message` 用英文。
- 详见 `skills/writing-kernel-api`。

### 模型与提示词
- **原生协议**：每个供应商插件用自家官方 SDK。不使用 LangChain 的 chat model 封装，不经 OpenAI 兼容层转译。模型或网关特定的补丁只存在于对应插件。
- **模型可见文案一律英文**：系统提示词、尾部提醒、压缩提示词、给模型看的错误。
- **模型看到的一切都进日志**：任何一次模型请求的输入都必须能从会话事件日志加 agent 版本确定性地还原。
- **事件日志只追加**：不改、不删已写入的事件。
- **发给模型的历史只追加**：已发送的消息原样重放，思考块等供应商私有数据不改动。压缩以「摘要替换较早前缀」的形式进行，是唯一允许的前缀变化。

### 界面与检查
- 界面文案走 i18n，第一版支持 `zh` 与 `en`，两份文案 key 必须同步（由新增检查保证）。
- 每道新增的自动检查必须先证明会红。

### 提交
- Conventional Commits，标题中文；提交身份 `Grant <284885069@qq.com>`。

## Review Focus

1. **worker 在流式输出途中被杀**：另一副本在 stalled 检测后从 checkpoint 续跑，该步重新调用模型。最终日志里每个 (run, step) 恰好一条 `assistant_message`；SSE 客户端先收到 `step_reset` 增量，最后看到完整回复。→ Task 12 测试 `resume after crash mid-step`、Task 18 双副本验收。
2. **运行中途或恰在运行结束的瞬间发来新消息**：这条消息要么作为插话被本轮吸收，要么触发新一轮，恰好处理一次，不丢失也不重复。→ Task 11 测试 `message at run boundary is processed exactly once`。
3. **在副本 A 点击中止、运行在副本 B 上**：最迟在下一个流式分块或步骤间隙停下；已流出的部分作为 `stopReason: "aborted"` 的 `assistant_message` 保存，之后不再调用模型。→ Task 11 与 Task 18 测试。
4. **供应商流卡住不发任何字节**：空闲看门狗触发后先同模型重试，再切到另一家供应商的兜底模型；不会一直挂到单轮时长上限。推理类模型使用更长的空闲阈值。→ Task 10 测试 `idle watchdog then fallback`。
5. **长会话逼近上下文上限**：只写一次 `compaction_summary`，之后的请求能放进窗口；压缩失败不会每轮都重试（有退避）。→ Task 9 与 Task 10 测试。

---

## M2 锁定的技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| Loop 编排 | `@langchain/langgraph` StateGraph，节点为 `prepare` → `model` → 路由（M3 加 `tools` 节点） | spec 4.4；只用它做编排与 checkpoint，不用 LangChain 的模型封装 |
| checkpointer | 内核自实现 `KyselyCheckpointSaver extends BaseCheckpointSaver`；需实现 `getTuple` / `list` / `put` / `putWrites` / `deleteThread`；用 `@langchain/langgraph-checkpoint-validation` 的 `validate(initializer)` 在 Vitest 中校验 | 表走纯 SQL 迁移、受迁移检查约束；一轮结束只留最新一份（spec 4.2） |
| 续跑幂等 | 模型调用前先查日志里是否已有该 (runId, step) 的 `assistant_message`，有则直接复用、不再调用模型 | 事件日志是事实；避免续跑后日志与状态不一致 |
| 流式传输 | SSE（`GET …/conversations/:id/stream?after=<seq>`）：先回放 PG 中 seq 之后的事件，再转发 Redis 频道上的实时增量 | 单向推送、可穿过 Next 代理、断线后按 seq 续接 |
| 中止 | Redis 键 `capk:run-abort:<runId>`（EX 3600）加内核 bus 广播 | 晚领取任务的 worker 也能看到中止标记 |
| 组织并发配额 | Redis ZSET `capk:org-runs:<orgId>`：member 为 runId，score 为租约到期时间；Lua 先清理过期成员再计数 | worker 崩溃不会让配额永久泄漏 |
| Anthropic 插件 | `@anthropic-ai/sdk` Messages API 流式调用。思考：`thinking: {type: "adaptive"}` + `output_config.effort`，不发送 `budget_tokens` 或 `disabled`。缓存：在稳定的系统提示块上加 `cache_control`。客户端工具开 `eager_input_streaming: true` 并校验解析结果。`tool_choice` 只用 `auto`。`stop_reason: "refusal"` 映射为 `refusal`。用 Models API 的 `max_input_tokens` / `max_tokens` 填充模型能力。 | claude-api 技能的当前用法 |
| OpenAI 插件 | `openai` Responses API 流式调用：`store: false`，`include: ["reasoning.encrypted_content"]`，推理项原样回传。函数调用用 `function_call` / `function_call_output` 项。模型能力由插件配置提供（OpenAI 的模型接口不返回上下文窗口大小）。 | OpenAI 的原生协议 |
| 前端 | Next 16 App Router，`apps/web`（私有包 `@capybara-hq/web`）；`next-intl`；经 `/api/*` 代理到内核（由路由处理函数转发，保证 SSE 流式不被缓冲） | spec 8.4、10 |

## 本计划纳入的遗留事项

- **用户裁决**：R24（改密码吊销个人访问令牌）→ Task 1；R25（登录限流按「登录名 + IP」计数）→ Task 1；Nacos 鉴权 → Task 3。
- **M1 全部轻微项**（`2026-10-17-m1-followups.md`）：
  - 账号、鉴权、初始化相关 → Task 1；
  - 组织、邀请、令牌、插件配置相关 → Task 2；
  - HTTP、生命周期、配置相关 → Task 3；
  - 文档与测试相关 → Task 18。
- **不纳入**：R26（发版前处理）；`m0-followups.md` 中「M6 前必须处理」与其余轻微项。

## 范围之外（M2 明确不做）

- 工具运行时与执行管线、工具策略与审批、MCP / OpenAPI 连接器、`tool_search`（M3）。M2 的 loop 预留 `tools` 节点和配对守卫，但不注册任何工具。
- `ctx.hooks` 与 `usage.report` 插件接缝（M3）。M2 只把用量写成 `usage` 事件。
- 渠道（IM）运行入口、定时触发（M4 起）。M2 的运行只能由 Web/API 的用户消息触发。
- 沙箱与技能（M5）、agent 组织角色的执行（M5）。M2 只存 `org_role` 列。
- 轨迹查看器、回放评测（M6）。
- 服务令牌发起会话：M2 的会话只接受用户 principal（服务令牌返回 403）。

---

## 文件结构

```
packages/plugin-sdk/src/model.ts                 # model-provider@1 契约（类型 + ModelError）
packages/testing/src/model-conformance.ts        # 供应商一致性测试套件
packages/testing/src/fake-model-server.ts        # 一致性测试用的本地 HTTP 桩工具（供插件写原生协议夹具）
packages/kernel/src/
├── agents/{agents.service,agents.controller,models.controller,definition}.ts
├── conversations/{event-log,conversations.service,conversations.controller,events}.ts
├── runtime/
│   ├── checkpointer.ts                          # KyselyCheckpointSaver
│   ├── context/{build,compaction,pairing,reminders,tokens}.ts   # 纯函数管线阶段
│   ├── model-call.ts                            # 单步模型调用：流式、看门狗、重试与降级、用量
│   ├── providers.ts                             # ProviderRegistry：从插件宿主取供应商与模型
│   ├── run-queue.ts                             # 内核运行队列与 ensureRun
│   ├── run-worker.ts                            # 运行任务处理：锁、配额、中止、停机、生命周期事件
│   ├── conversation-lock.ts  quota.ts  abort.ts
│   ├── loop.ts                                  # AgentLoop 接口
│   ├── langgraph-loop.ts                        # 默认实现
│   └── stream.controller.ts                     # SSE
├── migrations/{0004_agents,0005_conversations,0006_checkpoints}.sql
plugins/model-fake/                              # 确定性脚本化模型（测试与无密钥演示）
plugins/anthropic/   plugins/openai/
apps/web/                                        # Next 网页聊天
tools/checks/src/i18n.ts                         # 文案 key 同步检查
skills/writing-model-providers/SKILL.md
```

---

### Task 1: 鉴权与账号收尾（R24、R25 与 M1 轻微项）

**Files:**
- Modify:
  - `packages/kernel/src/identity/{rate-limit,auth.controller,me.controller,auth.guard,sessions,accounts,settings,principal}.ts`
  - `packages/kernel/src/orgs/invitations.{service,controller}.ts`
  - `packages/kernel/src/admin/{setup.controller,admin.controller}.ts`
  - `apps/capybara/src/commands/admin-create.ts`
  - `skills/writing-kernel-api/SKILL.md`
- Test: 现有 `packages/kernel/test/identity/*`、`test/orgs/invitations*.test.ts`、`test/admin/*`、`apps/capybara/test/admin-create.test.ts`

**Interfaces:**
- Produces:
  - **R25**：`LoginRateLimiter.reserve(login, ip)` 的计数键改为 `capk:login-fail:li:<sha256(login)>:<sha256(ip)>`（阈值 10）、`capk:login-fail:ip:<ip>`（阈值 50）、`capk:login-fail:l:<sha256(login)>`（单登录名全局上限，阈值 100）。三个键都由同一段 Lua 原子递增并设置 900s TTL；任一超限即拒绝。`succeeded(login, ip)` 删除 `li` 与 `l` 键，`ip` 键减一（不低于 0）。
    - 新增 `LoginRateLimiter.reserveScoped(scope: string, key: string, ip: string, limit: number)`，供改密码（scope `acct`）、`setupToken`（scope `setup`）、公开的接受邀请接口（scope `inv`）复用；这些 scope 的 IP 计数用 `capk:rl:<scope>:ip:<ip>`，与登录的 IP 额度分开。
  - **R24**：`PUT /me/password` 成功后，在吊销其他会话之外再调用 `ApiTokenService.revokeAllPersonal(accountId)`；`skills/writing-kernel-api` 中「现行的凭据行为」一节同步更新。
  - `LoginBody.login` 加 `max(256)`；改密码的 `newPassword` 同样受 12–256 长度限制。
  - `AuthGuard`：在 `@Public` 路由上只吞掉 `ApiError`（凭据无效视同未携带），PG / Redis 等其他异常照常抛出（返回 500）。
  - `SessionService.verifyAccess`：吊销检查与账号读取合并为一条查询（`sessions JOIN accounts`，按 sessionId 主键查）。`get()` 排除已过期的会话。`setCurrentOrg` 找不到会话时抛 `ApiError("auth.session_revoked")`。
  - `AccountsService.isLoginTaken` 只按约束名 `identities_pkey` 判断。
  - `SettingsService.get` 逐个键校验：非法的键用默认值并 `log.warn` 点名该键，其余合法的键保留。
  - 凭邀请注册时，scrypt 在事务开始之前计算：`AccountsService.createLocal` 新增可选参数 `passwordHash`。
  - `GET /admin/accounts` 的响应加 `next: string | null`。
  - CLI `admin create`：stdin 是 TTY 时关闭回显（`readline` 设为 muted），并提示 `Password: `。

- [ ] **Step 1: 写失败测试**：
  - `rate-limit.test.ts`：
    - 同一登录名从 11 个不同 IP 各错 1 次 → 都不被拒（per (login, IP) 计数）；
    - 同一 (login, IP) 错 10 次后第 11 次 429；
    - 同一登录名从 101 个不同 IP 各错 1 次 → 第 101 次 429（全局上限）；
    - `succeeded` 后 `li` 键消失；
    - `reserveScoped("acct", …)` 不消耗登录的 IP 额度。
  - `auth.http.test.ts`：
    - 攻击者 IP 把 admin 打到 10 次失败后，admin 从另一个 IP 用正确密码仍能登录（R25 的核心场景）；
    - `login` 为 257 字符 → 400 `validation_failed`；
    - PG 断开时访问 `@Public` 路由并携带 Cookie → 500（不是被当作匿名放行）；
    - 改密码后，该账号的个人访问令牌 401 `auth.required`（R24）；
    - 改密码失败 11 次 → 429，但同 IP 的登录不受影响；
    - Bearer 与 Cookie 同时出现时以 Bearer 为准，且仍不检查 CSRF；
    - 清 Cookie 的 `set-cookie` 带正确的 Path（`cap_rt` 为 `/api/v1/auth`）。
  - `sessions.test.ts`：已过期未吊销的会话 `get()` 返回 undefined；`setCurrentOrg` 对已吊销的会话抛 `auth.session_revoked`；`verifyAccess` 对每个请求只发一条 SQL（用 Kysely 的 `log` 钩子计数）。
  - `settings.test.ts`：往表里写入一个非法的 `orgCreation` 和一个合法的未来键 → 非法键回落默认值并产生 warn。
  - `invitations.test.ts`：凭邀请注册期间，在 `pg_stat_activity` 中观察不到该事务处于 `idle in transaction` 超过 50ms（做法：哈希函数先执行，事务内只有写入）；公开的接受邀请接口同 IP 连续 30 次失败 → 429。
  - `setup.http.test.ts`：配置了 `setupToken` 时，错误令牌 20 次 → 429。
  - `admin.http.test.ts`：`limit=1` 时 `next` 非空，用它取下一页得到下一个账号。
  - `accounts.test.ts`：把 R10 的计时测试改为 spy `verifyPassword`，断言超长密码不调用它；「停用 vs 降级」并发（独立连接池）后，活跃企业管理员仍至少一个。
  - `public-routes.test.ts`：增加「守卫确实设置了 principal」的断言——在测试中给全部 API 路由的 handler 外包一层检查，如果 handler 自己抛 `auth.required` 而守卫并没有拒绝，即判失败。实现方式：在测试模块里用 Nest 的 `APP_INTERCEPTOR` 记录 `req.principal` 是否由 `AuthGuard` 写入。
  - CLI：模拟 TTY（`node-pty` 不引入；改为把读密码的函数抽成 `readPassword(stream)`，单测 `isTTY=true` 时调用了 `setRawMode` 或使用了 muted 输出）。
- [ ] **Step 2: 运行确认失败**：`pnpm vitest run packages/kernel/test/identity packages/kernel/test/orgs packages/kernel/test/admin apps/capybara/test`。
- [ ] **Step 3: 实现**上列接口。
- [ ] **Step 4: 运行确认通过**；全量 `pnpm lint && pnpm typecheck && pnpm check && pnpm test` 全绿。
- [ ] **Step 5: 提交** `fix(kernel): 登录限流按登录名与 IP 计数，改密码吊销个人令牌，收尾 M1 鉴权遗留`。

### Task 2: 组织、邀请、令牌与插件配置收尾

**Files:**
- Modify: `packages/kernel/src/identity/{me.controller,api-tokens}.ts`、`packages/kernel/src/orgs/{invitations.service,orgs.controller}.ts`、`packages/kernel/src/plugins/org-config.ts`、`skills/writing-kernel-api/SKILL.md`
- Test: `packages/kernel/test/orgs/*`、`test/identity/tokens.http.test.ts`、`test/plugins/org-config*.test.ts`

**Interfaces:**
- Produces:
  - `PUT /me/current-org`：在一个事务内 `SELECT … FROM memberships WHERE org_id=$1 AND account_id=$2 FOR SHARE` 后再写会话，只查这一条成员关系。
  - 管理员给自己降级：允许，并在技能文档里写明；补测试固定这一行为。
  - `ApiTokenService`：`createService` 改为调用 `createServiceAs` 共用的私有 `insertToken(trx, …)`；`expiresAt` 的 schema 抽成共享的 `FutureIsoDate`（`z.iso.datetime()` 再 `refine` 必须晚于当前时间），两个 controller 共用。
  - `OrgPluginConfigs`：
    - `get()` / `list()` 在 `REPEATABLE READ` 只读事务里读配置行与密钥；
    - `get()` 对 `enabled=false` 的插件不做 schema 校验，返回 `{ enabled: false, config: null }`；
    - `put()` 同一事务内删除当前 schema 中已不存在的密钥路径对应的 `capybara.secrets` 行；
    - 没有记录时只传 `enabled:false`，`config` 存 `null`，`list()` 显示 `config: null`。
  - 邀请：去掉冗余的成员预检查（`members.add` 已经检查），保留错误码不变。

- [ ] **Step 1: 写失败测试**：
  - `current-org`：并发执行「移出成员」和「`PUT /me/current-org`」50 轮（独立连接池），结束后该会话的 `current_org_id` 不指向已移出的组织。
  - `orgs.http.test.ts`：
    - 服务令牌（member）对另一组织调用 HUMAN_ONLY 路由（`PATCH /orgs/<B>/members/x`）→ 404 `org.not_found`；
    - 已软删除组织与不存在组织的 404 响应逐字节相同；
    - admin 自降为 member 成功，审计里有记录。
  - `tokens.http.test.ts`：`expiresAt: 1893456000`（数字）→ 400；`expiresAt: "2099-01-01"`（非完整 ISO datetime）→ 400；`"2099-01-01T00:00:00Z"` → 201。
  - `org-config.test.ts`：
    - 在 `get()` 读完配置行之后、读密钥之前，并发提交一次 `put()`（在测试里给 Kysely 加插桩来卡住时机）→ `get()` 返回的结果来自同一次提交；
    - 删掉 schema 中的 `webhook.token` 字段后再次 `put` → `capybara.secrets` 中对应行被删除；
    - 已停用插件存了非法配置 → `get()` 返回 `{enabled:false, config:null}`、不抛错；
    - 回滚测试：在审计写入时抛错（注入失败的审计函数）→ 密钥与配置都未改变。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**；全量全绿。
- [ ] **Step 5: 提交** `fix(kernel): 收尾 M1 组织、邀请、令牌与插件配置遗留`。

### Task 3: HTTP、生命周期与配置收尾，Nacos 鉴权

**Files:**
- Modify:
  - `packages/kernel/src/http/{plugin-dispatch,error.filter,nest-logger}.ts`
  - `packages/kernel/src/kernel.ts`
  - `packages/kernel/src/plugins/host.ts`
  - `packages/kernel/src/ctx/create-ctx.ts`
  - `packages/kernel/src/db/{pool,migrator}.ts`
  - `packages/kernel/src/config/{nacos-source,load,fields}.ts`
  - `packages/kernel/src/log.ts`
  - `skills/{adding-config,writing-plugins}/SKILL.md`、`docs/config.md`
- Test: `packages/kernel/test/http/*`、`test/lifecycle.test.ts`、`test/kernel.test.ts`、`test/config/*`、`test/plugins/host.test.ts`

**Interfaces:**
- Produces:
  - **插件分发**：
    - `HEAD` 请求在没有 HEAD 路由时按 GET 匹配（Node 会丢弃响应体）；
    - 插件作用域的 `setErrorHandler` 把 Fastify 错误映射为错误信封（413 → `payload_too_large`，415 → `unsupported_media_type`，其余 4xx 按通用表）；
    - 构造 `Request` 失败（畸形 Host）时返回 400 `validation_failed`，不记 error 日志；
    - `plugin handler failed` 日志的路径经 `redactPath` 脱敏。
  - **Nest 日志**：`NestLogAdapter.log` 降为 debug 级。
  - **停机预算**：等待 listen 与关闭 HTTP 共用一个 10s 的 HTTP 阶段截止时间。
  - **`ctx.db`**：Proxy 递归包裹方法返回的 Kysely 与传入回调的 Kysely（包括 `connection().execute(cb)` 与 `transaction().execute(cb)` 回调里拿到的实例），使 `destroy` 在任何路径都被拦截。
  - **`PluginHost`**：
    - `load()` 中 `ctx.close()` 的失败要记 warn；
    - `migrateOnly` 也执行 `assertSecretsReachable`；
    - 插件 setup 永不返回时 `start()` 永远挂起，这一点在 `writing-plugins` 中写明。
  - **连接超时参数**：`connectTimeoutMs` 的条件展开收敛为一个 `pgConnectOptions(cfg)` 帮助函数。
  - **日志打码**：`log.addSecrets` 接受非字符串值（数字、布尔转成字符串后加入打码）；部署配置与组织配置里的嵌套密钥都覆盖。
  - **Nacos 鉴权**：`createNacosSource` 增加 `auth?: { username: string; password: string } | { accessToken: string }`。
    - 用户名密码方式：先 `POST {server}/nacos/v1/auth/login`（表单 `username`、`password`），拿到 `accessToken` 与 `tokenTtl`；后续 `load` / `watch` 请求都带 `accessToken` 查询参数；在 TTL 的 80% 时（或收到 403 时）重新登录。
    - 环境变量：`CAPYBARA_NACOS_USERNAME`、`CAPYBARA_NACOS_PASSWORD`、`CAPYBARA_NACOS_ACCESS_TOKEN`（与其他 `CAPYBARA_NACOS_*` 一样不进入配置 schema）。
    - 登录失败要快速失败，错误信息含 server，不含密码。
  - `adding-config` 写明：整段 JSON 环境变量与逐字段环境变量同时设置会判冲突。

- [ ] **Step 1: 写失败测试**：
  - `plugin-dispatch.test.ts`：
    - HEAD 访问 GET 路由 → 200 且无响应体；
    - 2 MiB 请求体 → 413，body 为 `{error:{code:"payload_too_large"}}`；
    - `host: "a b"` → 400，且捕获的日志中没有 error 级记录；
    - 插件路径中的令牌在日志里被脱敏。
  - `error.filter.test.ts`：`ApiError` 带 `details` 时原样返回；Nest `HttpException(503)` → `internal` 且保留 503；未知异常 → 500 并记 error；
  - `kernel.test.ts`：404 断言加上 `code === "not_found"`；启动日志中没有 info 级的 `Mapped`。
  - `lifecycle.test.ts`：
    - 「listen 卡住 + 慢 HTTP 连接」时 HTTP 阶段总用时 ≤ 10.5s；
    - 插件在 `ctx.db.transaction().execute(t => t.destroy())` → setup 失败，错误含 `not allowed`；
    - cleanup 测试还要断言 Redis 断开与 bus 关闭；
    - `slow` fixture 改为由测试创建 deferred（通过 `pluginConfig` 传入一个 key，fixture 从 `globalThis` 的 Map 中按 key 取，测试结束清理）；
    - api-only 不消费任务的检查改为事件驱动：投递后再起一个 worker 内核，断言任务由后起的 worker 执行（handler 记录副本标识）。
  - `host.test.ts`：插件 close 抛错 → 有 warn；`migrateOnly` 加载带 union 密钥的插件 → 抛错。
  - `config/env.test.ts`：`CAPYBARA_DB__URL` 与 `CAPYBARA_DB__URL_EXTRA` 不冲突；`CAPYBARA_LOG` 与 `CAPYBARA_LOGGING__X` 不冲突；`CAPYBARA_CONFIG_SOURCE` / `CAPYBARA_NACOS_SERVER` 不参与冲突检测。
  - `log.test.ts`：数字密钥 `12345678` 被打码；嵌套的组织配置密钥被打码。
  - `nacos-source.test.ts`（用桩服务器）：
    - 用户名密码登录后，配置请求带 `accessToken`；
    - 桩服务器返回 403 → 重新登录一次后成功；
    - 登录返回 403 → `load()` 抛错，信息含 server、不含密码；
    - 传 `accessToken` 时不调用登录接口；
    - `tokenTtl: 2` 时，约 1.6s 后续期请求出现（用 vitest 假时钟）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**；`pnpm gen:config-docs`（如有 schema 改动）。
- [ ] **Step 4: 运行确认通过**；全量全绿。
- [ ] **Step 5: 提交** `fix(kernel): 收尾 M1 HTTP、生命周期与配置遗留，Nacos 支持鉴权`。

### Task 4: `model-provider@1` 契约与一致性测试套件

**Files:**
- Create: `packages/plugin-sdk/src/model.ts`、`packages/plugin-sdk/test/model.test.ts`、`packages/testing/src/{model-conformance,fake-model-server}.ts`、`packages/testing/test/fake-model-server.test.ts`
- Modify: `packages/plugin-sdk/src/index.ts`、`packages/testing/src/index.ts`、`packages/testing/package.json`（`vitest` 作为 peerDependency）

**Interfaces:**
- Produces（全部从 `@capybara-hq/plugin-sdk` 导出，不引入任何运行时依赖）：
  ```ts
  export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
  export interface ModelInfo {
    id: string; displayName: string; contextWindow: number; maxOutputTokens: number;
    capabilities: { tools: boolean; vision: boolean; reasoning: boolean; caching: boolean;
      midConversationSystem: boolean; effort: boolean };
    /** 流空闲看门狗阈值；推理类模型应更长。未给时内核用配置默认值。 */
    streamIdleTimeoutMs?: number;
  }
  /** 供应商私有数据：只回放给同一供应商（如 Anthropic 思考块签名、OpenAI 加密推理项）。 */
  export interface ProviderOpaque { provider: string; model: string; data: unknown }
  export type ContentBlock =
    | { type: "text"; text: string }
    | { type: "thinking"; text: string; opaque?: ProviderOpaque }
    | { type: "tool_call"; id: string; name: string; input: unknown; opaque?: ProviderOpaque }
    | { type: "tool_result"; callId: string; content: string; isError: boolean };
  export type ModelMessage =
    | { role: "user"; content: ContentBlock[] }
    | { role: "assistant"; content: ContentBlock[] }
    /** 对话中途的系统提醒；模型不支持时由插件转成 user 文本块（以 "[system] " 开头）。 */
    | { role: "system"; content: string };
  export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
  export interface ModelRequest {
    model: string;
    /** 稳定内容在前；cache 为 true 的块之后打缓存断点（由插件按原生协议实现）。 */
    system: { text: string; cache: boolean }[];
    messages: ModelMessage[];
    tools: ToolDefinition[];          // M2 恒为 []
    maxOutputTokens: number;
    effort?: Effort;
  }
  export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  export interface ModelUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  export type ModelStreamEvent =
    | { type: "text_delta"; text: string }
    | { type: "thinking_delta"; text: string }
    | { type: "message_complete"; content: ContentBlock[]; stopReason: StopReason; usage: ModelUsage };
  export type ModelErrorKind = "rate_limited" | "overloaded" | "server" | "timeout" | "network"
    | "auth" | "invalid_request" | "context_overflow" | "aborted";
  export class ModelError extends Error {
    constructor(kind: ModelErrorKind, message: string, opts?: { retryAfterMs?: number; cause?: unknown });
    readonly kind: ModelErrorKind;
    /** rate_limited / overloaded / server / timeout / network 为 true。 */
    get retryable(): boolean;
  }
  export interface ModelProvider {
    listModels(): Promise<ModelInfo[]>;
    /** 事件序列必须以且仅以一个 message_complete 结束；出错抛 ModelError。 */
    stream(req: ModelRequest, opts: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
  }
  export const MODEL_PROVIDER_CAPABILITY = "model-provider@1";
  ```
- `@capybara-hq/testing`：
  - `describeModelProviderConformance(name: string, setup: () => Promise<ConformanceTarget>)`，`ConformanceTarget = { provider: ModelProvider; model: string; expect: { thinking: boolean; caching: boolean }; teardown(): Promise<void> }`。它注册以下 Vitest 用例：
    - `streams text`：delta 拼起来等于最终的 text 块，以 `message_complete` 结束，`stopReason` 为 `end_turn`；
    - `tool round trip`：带一个 `get_weather` 工具 → 得到 `tool_call` 且 `input` 为已解析对象、`stopReason` 为 `tool_use`；回传 `tool_result` → 得到最终 text；
    - `thinking replay`：仅当 `expect.thinking` 为 true 时运行。首轮有 thinking 块，把整个 assistant 内容原样回传，第二轮成功；
    - `caching`：仅当 `expect.caching` 为 true 时运行。两次相同前缀的请求，第二次 `cacheReadTokens > 0`；
    - `usage`：`inputTokens > 0` 且 `outputTokens > 0`；
    - `mid-conversation system`：带 `role:"system"` 消息的请求成功；
    - `abort`：流开始后 abort → 抛 `ModelError` 且 kind 为 `aborted`，事件不再继续产出。
  - `startFakeModelServer(routes: (req: { path: string; body: unknown; headers: Record<string,string> }) => FakeResponse): Promise<{ url: string; requests: …[]; stop(): Promise<void> }>`。`FakeResponse` 可以是 `{ status, json }`、`{ status: 200, sse: { event?: string; data: string }[]; delayMs?: number }` 或 `{ stall: true }`（只发响应头、不发数据）。供插件编写原生协议的夹具。

- [ ] **Step 1: 写失败测试**：`model.test.ts`：`new ModelError("rate_limited", "x").retryable === true`、`auth` → false、`aborted` → false；`MODEL_PROVIDER_CAPABILITY === "model-provider@1"`。`fake-model-server.test.ts`：SSE 路由按顺序发出事件；`stall` 路由只返回响应头；`requests` 记录了请求体。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（`ModelError` 是纯类，不依赖任何包）。
- [ ] **Step 4: 运行确认通过**；`pnpm check`（依赖边界检查要求 SDK 不 import 其他包）全绿。
- [ ] **Step 5: 提交** `feat(plugin-sdk): model-provider@1 契约与供应商一致性测试套件`。

### Task 5: `model-fake` 插件

**Files:**
- Create: `plugins/model-fake/{package.json,src/index.ts,src/script.ts,test/model-fake.test.ts,test/conformance.test.ts}`

**Interfaces:**
- Consumes：Task 4 的全部类型与 `describeModelProviderConformance`。
- Produces：插件 `@capybara-hq/plugin-model-fake`（name `model-fake`），提供 `model-provider@1`。
  - 部署配置：`{ models?: { id: string; contextWindow?: number; streamIdleTimeoutMs?: number }[] }`，默认一个模型 `fake-1`（contextWindow 32000，capabilities 全 false，caching 为 true）。
  - 行为由最后一条 user 消息的文本决定（脚本指令都是英文前缀，便于测试与演示）：
    - `echo:<text>`：按 4 字符一块流出 `<text>`；
    - `slow:<ms>:<text>`：每块之间间隔 `<ms>` 毫秒；
    - `stall`：不产出任何事件，直到 abort；
    - `fail:<kind>`：抛对应 kind 的 `ModelError`；
    - `tool:<name>:<json>`：产出 `tool_call`；
    - `long:<n>`：输出 n 个单词；
    - 其他文本：回复 `You said: <text>`。
  - usage：inputTokens = 全部输入字符数 ÷ 4 向上取整；outputTokens 同理。同一个 system 前缀第二次出现时报告 cacheReadTokens，前缀命中记录在 `ctx.kv`（TTL 300s）。
  - 支持 `role:"system"`（capability `midConversationSystem: true`）。
  - 压缩请求：system 中含 `CAPYBARA_COMPACTION` 标记时，回复 `Summary: <前 200 字符>`。

- [ ] **Step 1: 写失败测试**：`model-fake.test.ts` 逐条测上述指令（`slow` 用 vitest 假时钟、`stall` 用 abort、`fail:rate_limited` 断言 `retryable`）；`conformance.test.ts` 调用 `describeModelProviderConformance("model-fake", …)`，`expect: { thinking: false, caching: true }`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（插件不保存模块级状态；缓存命中记录走 `ctx.kv`）。
- [ ] **Step 4: 运行确认通过**；`pnpm check`（插件状态检查）全绿。
- [ ] **Step 5: 提交** `feat(plugins): model-fake 确定性模型插件`。

### Task 6: Agent 定义与版本

**Files:**
- Create: `packages/kernel/src/migrations/0004_agents.sql`、`packages/kernel/src/agents/{definition,agents.service,agents.controller,models.controller}.ts`、`packages/kernel/src/runtime/providers.ts`、`packages/kernel/test/agents/{agents,agents.http,providers}.test.ts`
- Modify: `packages/kernel/src/db/kernel-schema.ts`、`packages/kernel/src/orgs/roles.ts`、`packages/kernel/src/errors.ts`、`packages/kernel/src/http/{api.module,tokens}.ts`

**Interfaces:**
- Consumes：`lockOrgAndAuthorize`、`OrgAction`、`@OrgAction`、`audit()`（M1）；`PluginHost.list("model-provider")`；Task 4 的 `ModelProvider` / `ModelInfo`。
- Produces：
  - `0004_agents.sql`：
    ```sql
    CREATE TABLE IF NOT EXISTS capybara.agents (
      id text PRIMARY KEY,
      org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
      owner_account_id text NOT NULL REFERENCES capybara.accounts(id),
      visibility text NOT NULL CHECK (visibility IN ('private', 'org', 'members')),
      org_role text NOT NULL DEFAULT 'member' CHECK (org_role IN ('admin', 'member', 'guest')),
      current_version integer NOT NULL,
      needs_reassignment boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS agents_org_idx ON capybara.agents (org_id) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS capybara.agent_versions (
      agent_id text NOT NULL REFERENCES capybara.agents(id) ON DELETE CASCADE,
      version integer NOT NULL,
      definition jsonb NOT NULL,
      created_by text NOT NULL REFERENCES capybara.accounts(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (agent_id, version)
    );
    CREATE TABLE IF NOT EXISTS capybara.agent_members (
      agent_id text NOT NULL REFERENCES capybara.agents(id) ON DELETE CASCADE,
      account_id text NOT NULL REFERENCES capybara.accounts(id) ON DELETE CASCADE,
      PRIMARY KEY (agent_id, account_id)
    );
    ```
  - `definition.ts`：`AgentDefinitionSchema = z.object({ name: z.string().min(1).max(80), avatarUrl: z.url().nullable().default(null), instructions: z.string().max(100_000).default(""), model: ModelRef, fallback: ModelRef.nullable().default(null), effort: z.enum([...]).nullable().default(null), tools: z.array(z.never()).default([]) /* M3 */ })`；`ModelRef = z.object({ provider: z.string(), model: z.string() })`。
  - `roles.ts` 追加动作：`"agents.create"`（member）、`"agents.use"`（guest）；`HUMAN_ONLY` 自动包含 `agents.create`，不包含 `agents.use`（服务令牌在 M2 被会话接口另行拒绝）。
  - `errors.ts` 追加：`"agent.not_found": 404`、`"agent.model_unavailable": 400`。
  - `ProviderRegistry(host: PluginHost, kv: Redis)`：
    - `list(): Promise<{ provider: string; models: ModelInfo[] }[]>`：每个供应商的 `listModels()` 结果缓存在 Redis `capk:models:<provider>`，EX 600；
    - `resolve(ref: ModelRef): Promise<{ provider: ModelProvider; info: ModelInfo }>`：未安装或模型不存在 → `agent.model_unavailable`。
  - `AgentsService(db, registry)`：
    - `create(orgId, actorAccountId, input: { definition: AgentDefinition; visibility; memberIds?: string[] }): Promise<{ agent: AgentView; warnings: string[] }>`——在组织行锁内授权 `agents.create`；校验 model 与 fallback 都可解析；`fallback.provider === model.provider` 时 `warnings` 含 `"fallback_same_provider"`（spec 4.5：只提示，不拒绝）；写入版本 1；审计 `agent.created`。
    - `update(orgId, agentId, actorAccountId, patch: { definition?; visibility?; memberIds? })`：只有负责人或组织管理员以上可改，在锁内复核；`definition` 变化时生成新版本（`current_version + 1`）；审计 `agent.updated`（`detail` 含 `{ fromVersion, toVersion }`）。
    - `get(orgId, agentId, viewerAccountId): Promise<AgentView>`、`listVisible(orgId, viewerAccountId): Promise<AgentView[]>`、`softDelete(orgId, agentId, actorAccountId)`、`getVersion(agentId, version)`、`listVersions(agentId)`。
    - 可见性判定 `canUse(agent, viewer)`：未删除，且满足以下之一：viewer 是负责人；`visibility='org'` 且 viewer 是组织成员（含访客）；`visibility='members'` 且 viewer 在 `agent_members` 中。不可见一律 `agent.not_found`。
    - `AgentView = { id; orgId; ownerAccountId; visibility; currentVersion; definition: AgentDefinition; memberIds: string[] | null; createdAt; updatedAt }`。
  - 端点（前缀 `/api/v1/orgs/:orgId`）：
    - `POST /agents`（`agents.create`）→ 201 `{ agent, warnings }`；
    - `GET /agents`（`agents.use`）→ `{ agents }`；
    - `GET /agents/:agentId`；
    - `PATCH /agents/:agentId` → `{ agent, warnings }`；
    - `DELETE /agents/:agentId` → 204；
    - `GET /agents/:agentId/versions` → `{ versions: { version, createdBy, createdAt }[] }`；
    - `GET /models`（`agents.use`）→ `{ providers: { provider, models: ModelInfo[] }[] }`。

- [ ] **Step 1: 写失败测试**（用 `model-fake` 插件，配置两个模型并另外加载一个名为 `model-fake-b` 的第二个 fixture 供应商）：
  - 创建后版本为 1；只改 visibility 不产生新版本；改 instructions 版本变为 2，且 `getVersion(agent, 1)` 仍返回旧定义。
  - 同一供应商作为兜底 → `warnings` 为 `["fallback_same_provider"]`；不存在的模型 → 400 `agent.model_unavailable`。
  - 可见性矩阵（表驱动）：负责人 / 同组织成员 / 访客 / members 名单内 / 名单外 / 其他组织，分别对 `private` / `org` / `members` 三种可见性的结果。
  - 非负责人的 member 改别人的 agent → 403 `forbidden`；admin 可以改。
  - 负责人在 `PATCH` 之前被移出组织 → 403（锁内复核）。
  - 访客 `POST /agents` → 403；服务令牌 `POST /agents` → 403；服务令牌 `GET /agents` → 200（`agents.use` 不属于 HUMAN_ONLY）。
  - `GET /models` 第二次调用不再访问供应商（fixture 统计 `listModels` 的调用次数为 1）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**（含公开路由元测试）。
- [ ] **Step 5: 提交** `feat(kernel): Agent 定义、版本与可见范围`。

### Task 7: 会话与事件日志

**Files:**
- Create: `packages/kernel/src/migrations/0005_conversations.sql`、`packages/kernel/src/conversations/{events,event-log,conversations.service,conversations.controller}.ts`、`packages/kernel/test/conversations/{event-log,conversations.http}.test.ts`
- Modify: `kernel-schema.ts`、`errors.ts`、`api.module.ts`、`tokens.ts`

**Interfaces:**
- Consumes：`AgentsService.get` / `canUse`（Task 6）。
- Produces：
  - `0005_conversations.sql`：
    ```sql
    CREATE TABLE IF NOT EXISTS capybara.conversations (
      id text PRIMARY KEY,
      org_id text NOT NULL REFERENCES capybara.orgs(id) ON DELETE CASCADE,
      agent_id text NOT NULL REFERENCES capybara.agents(id),
      account_id text NOT NULL REFERENCES capybara.accounts(id),
      title text,
      last_seq bigint NOT NULL DEFAULT 0,
      consumed_seq bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS conversations_account_idx ON capybara.conversations (org_id, account_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS capybara.conversation_events (
      conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
      seq bigint NOT NULL,
      type text NOT NULL,
      run_id text,
      idem_key text,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, seq)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS conversation_events_idem_uq
      ON capybara.conversation_events (conversation_id, idem_key) WHERE idem_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS capybara.runs (
      id text PRIMARY KEY,
      conversation_id text NOT NULL REFERENCES capybara.conversations(id) ON DELETE CASCADE,
      status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'aborted')),
      agent_version integer NOT NULL,
      trigger_account_id text NOT NULL REFERENCES capybara.accounts(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS runs_conversation_idx ON capybara.runs (conversation_id, created_at DESC);
    ```
  - `events.ts`：事件类型的 zod 判别联合 `ConversationEventSchema`（`type` + `payload`），M2 共 10 种：
    - `user_message` `{ content: ContentBlock[]; authorAccountId: string; clientMessageId?: string }`
    - `run_started` `{ agentVersion: number; model: ModelRef; triggerAccountId: string }`
    - `model_call` `{ step: number; attempt: number; provider: string; model: string; fallback: boolean; request: { fromSeq: number; toSeq: number; summarySeq: number | null; systemHash: string; reminderSeqs: number[] } }`
    - `assistant_message` `{ step: number; content: ContentBlock[]; stopReason: StopReason | "aborted" }`
    - `usage` `{ step: number; provider: string; model: string } & ModelUsage`
    - `reminder` `{ step: number; text: string }`
    - `compaction_summary` `{ coversUpToSeq: number; text: string }`
    - `compaction_failed` `{ attempt: number; reason: string }`
    - `run_finished` `{ reason: "completed" | "max_steps" | "max_duration"; consumedUpToSeq: number }`
    - `run_failed` `{ error: { code: string; message: string } }`
    - `run_aborted` `{ byAccountId: string | null; reason: "user" | "shutdown_exhausted" }`
    - 类型 `ConversationEvent = { conversationId; seq; type; runId: string | null; payload; createdAt }`。
  - `EventLog(db, bus: { publish(topic, payload) })`：
    - `append(conversationId, events: { type; runId?: string; idemKey?: string; payload }[], trx?): Promise<ConversationEvent[]>`：用 `UPDATE conversations SET last_seq = last_seq + $n, updated_at = now() WHERE id = $1 RETURNING last_seq` 分配连续 seq（行锁串行化）；带 `idemKey` 的事件已存在时返回已有事件、不分配新 seq（先查后写都在同一行锁内）；payload 用 `ConversationEventSchema` 校验。事务提交后发布 `kernel` bus 主题 `conv.<conversationId>`，payload 为 `{ kind: "events", toSeq }`（传了外部 trx 时由调用方在提交后调用 `notify`）。
    - `notify(conversationId, toSeq)`、`readAfter(conversationId, afterSeq, limit = 500): Promise<ConversationEvent[]>`、`findByIdem(conversationId, idemKey)`。
  - `ConversationsService(db, eventLog, agents)`：
    - `create(orgId, accountId, agentId)`：要求 `canUse`；
    - `get(orgId, conversationId, viewerAccountId)`：只有会话所有者可读，否则 404 `conversation.not_found`；每次调用都实时复核 agent 仍可用（R5）。
    - `listMine(orgId, accountId, opts: { after?: string; limit })`。
    - `postUserMessage(orgId, conversationId, accountId, input: { text: string; clientMessageId?: string }): Promise<ConversationEvent>`：`idemKey = clientMessageId`，重复提交返回同一事件。运行的触发在 Task 11 中接入。
  - `errors.ts` 追加：`"conversation.not_found": 404`。
  - 端点（前缀 `/api/v1/orgs/:orgId`；`@OrgAction("agents.use")`；service principal → 403 `forbidden`）：
    - `POST /conversations` `{ agentId }` → 201；
    - `GET /conversations` → `{ conversations, next }`；
    - `GET /conversations/:id`；
    - `GET /conversations/:id/events?after=<seq>` → `{ events }`；
    - `POST /conversations/:id/messages` `{ text (1–100000), clientMessageId? }` → 202 `{ event }`。

- [ ] **Step 1: 写失败测试**：
  - event-log：100 次并发 append（两个独立连接池，各 50 次）后 seq 连续 1..100、无重复；同一个 `idemKey` 并发 append 10 次只产生一条事件；非法 payload 被拒；提交后 bus 收到 `toSeq`；在外部 trx 中 append 后回滚 → 没有事件、`last_seq` 不变。
  - HTTP：
    - 别人的会话 → 404；
    - agent 改成 private 后，原有会话 `GET` → 404（实时复核）；
    - 同一个 `clientMessageId` 提交两次 → 返回同一 seq；
    - 服务令牌 → 403；
    - `events?after=` 分页正确；
    - text 为空 → 400。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): 会话与只追加的事件日志`。

### Task 8: Kysely checkpointer

**Files:**
- Create: `packages/kernel/src/migrations/0006_checkpoints.sql`、`packages/kernel/src/runtime/checkpointer.ts`、`packages/kernel/test/runtime/checkpointer.test.ts`
- Modify: `packages/kernel/package.json`（`@langchain/langgraph`、`@langchain/langgraph-checkpoint`、`@langchain/core`，dev 加 `@langchain/langgraph-checkpoint-validation`）、`kernel-schema.ts`

**Interfaces:**
- Produces：
  - `0006_checkpoints.sql`：
    ```sql
    CREATE TABLE IF NOT EXISTS capybara.lg_checkpoints (
      thread_id text NOT NULL,
      checkpoint_ns text NOT NULL DEFAULT '',
      checkpoint_id text NOT NULL,
      parent_checkpoint_id text,
      checkpoint_type text NOT NULL,
      checkpoint bytea NOT NULL,
      metadata_type text NOT NULL,
      metadata bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
    );
    CREATE TABLE IF NOT EXISTS capybara.lg_checkpoint_writes (
      thread_id text NOT NULL,
      checkpoint_ns text NOT NULL DEFAULT '',
      checkpoint_id text NOT NULL,
      task_id text NOT NULL,
      idx integer NOT NULL,
      channel text NOT NULL,
      value_type text NOT NULL,
      value bytea NOT NULL,
      task_path text NOT NULL DEFAULT '',
      PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
    );
    ```
  - `class KyselyCheckpointSaver extends BaseCheckpointSaver`：构造参数 `(db: KernelDb)`；实现 `getTuple`、`list`（支持 `filter`、`before`、`limit`，按 `checkpoint_id` 降序）、`put`、`putWrites`（同一 (task, idx) 已存在时，非特殊 channel 冲突则忽略）、`deleteThread`；序列化用继承来的 `this.serde.dumpsTyped` / `loadsTyped`。
  - 额外方法 `pruneToLatest(threadId: string): Promise<number>`：只保留 `checkpoint_ns=''` 下最新的一个 checkpoint 及其 writes，返回删除的条数（spec 4.2：一轮结束后只留最新一份）。
  - thread_id 约定为 runId（Task 12 使用）。

- [ ] **Step 1: 写失败测试** `checkpointer.test.ts`：
  - `validate(initializer)`：用 `@langchain/langgraph-checkpoint-validation` 校验；initializer 每次 `createCheckpointer` 时清空两张表（测试库独占）。
  - `pruneToLatest`：写 5 个 checkpoint 后剪枝 → 只剩最新的那个，且 `getTuple` 仍能取回它。
  - 在一个最小的 StateGraph（两个节点）上用该 saver 跑一遍，中途抛错；再以 `invoke(null, { configurable: { thread_id } })` 续跑，从断点继续执行。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**（校验套件全部用例通过）。
- [ ] **Step 5: 提交** `feat(kernel): 基于 Kysely 的 LangGraph checkpointer`。

### Task 9: 上下文构建与管线阶段（纯函数）

**Files:**
- Create: `packages/kernel/src/runtime/context/{build,compaction,pairing,reminders,tokens}.ts`、`packages/kernel/test/runtime/context/*.test.ts`

**Interfaces:**
- Consumes：Task 4 的类型；Task 7 的 `ConversationEvent`；Task 6 的 `AgentDefinition`。
- Produces（全部是不做 I/O 的纯函数）：
  - `tokens.ts`：
    - `estimateTokens(messages: ModelMessage[], system: ModelRequest["system"]): number`：ASCII 字符数 ÷ 4 加上非 ASCII 字符数 × 1，向上取整；不调用任何 BPE 分词器（spec 6、可靠性清单 A：避免长段中文阻塞事件循环）。
    - `calibrate(estimate: number, lastActual: { estimate: number; inputTokens: number } | null): number`：有上一轮的真实值时按 `inputTokens / estimate` 比例校正，比例夹在 0.5–3 之间。
  - `build.ts`：`buildModelRequest(input: { events: ConversationEvent[]; agent: AgentDefinition; agentVersion: number; model: ModelInfo; step: number; reminders: string[] }): { request: ModelRequest; meta: ModelCallMeta }`。规则：
    - **system**：一个块 `{ text: <平台行为规范（英文，短而通用，写死在 build.ts 的常量 BEHAVIOR_RULES 中）> + "\n\n" + agent.instructions, cache: true }`。不放任何时间戳或会话 ID 之类会变化的内容（保证缓存前缀稳定）。
    - **消息**：取最近一条 `compaction_summary` 之后的事件。如果有摘要，第一条消息为 `{ role: "user", content: [{ type: "text", text: "<conversation_summary>\n" + summary + "\n</conversation_summary>" }] }`。其后 `user_message` → user，`assistant_message` → assistant（content 原样回放，包括 opaque）。同一 run 的 `reminder` 事件 → `role: "system"`，放在它所在的位置。
    - `reminders` 参数 → 追加在末尾的 `role: "system"` 消息（由调用方先把它们写成 `reminder` 事件；这里只负责按事件重建）。
    - `stopReason === "aborted"` 的 assistant 消息照常回放（其中的文本是已流出的部分）。
    - `ModelCallMeta = { fromSeq; toSeq; summarySeq: number | null; systemHash: string /* sha256 */; reminderSeqs: number[] }`，与 `model_call` 事件的 `request` 字段相同。
  - `pairing.ts`：`guardToolPairs(messages: ModelMessage[]): ModelMessage[]`——assistant 中没有对应 `tool_result` 的 `tool_call`，在其后补一条 `tool_result { isError: true, content: "Result unknown: the call was interrupted before a result was recorded. Verify the outcome before retrying." }`；孤立的 `tool_result`（没有对应 call）删除。M2 没有工具，但这个阶段必须存在并有测试（spec 6.2）。
  - `reminders.ts`：`turnLimitReminder(step: number, maxSteps: number): string | null`——`step >= maxSteps - 2` 时返回英文软提醒 `"You are close to the step limit for this turn (step N of M). Wrap up and give the user your best answer now."`。
  - `compaction.ts`：
    - `shouldCompact(estimatedTokens: number, model: ModelInfo, threshold: number /* 0.8 */): boolean`；
    - `compactionPlan(events: ConversationEvent[], keepRecentTurns: number): { coversUpToSeq: number; transcript: string } | null`：保留最近 `keepRecentTurns` 个「以 user_message 开头的轮次」原文，更早的内容转成纯文本对话记录；可压缩的内容为空时返回 null。
    - `buildCompactionRequest(transcript: string, model: string): ModelRequest`：system 为英文的摘要指令，并带 `CAPYBARA_COMPACTION` 标记。
    - `acceptSummary(text: string, transcript: string): boolean`：摘要长度 ≥ 200 字符，或 ≥ 原文的 5%，取二者中较小者（过短视为失败，可靠性清单 A）。
    - `compactionBackoff(events: ConversationEvent[]): boolean`：最近一次 `compaction_failed` 之后新增的 user 轮次少于 `2^attempt` 时返回 true（即本轮跳过压缩）。

- [ ] **Step 1: 写失败测试**（全部用构造出来的事件数组，不连库）：
  - **确定性**：同样的事件与定义调用两次，`request` 深相等，`systemHash` 相同。
  - **还原性**：按 `meta.fromSeq..toSeq` 与 `summarySeq` 截取事件后重建，得到相同的 request（「任何一次模型请求的输入都可从日志还原」）。
  - **只追加**：在 N 条事件上构建出 R1，再追加一条 user 消息构建出 R2 → `R2.messages` 的前缀与 `R1.messages` 深相等，opaque 数据原样保留。
  - **压缩后**：有摘要时首条为 `<conversation_summary>`，摘要之前的事件不出现。
  - **system 前缀稳定**：两个不同会话、同一个 agent 版本 → system 文本完全相同。
  - **配对守卫**：补齐 unknown result；删除孤立 result。
  - **提醒**：maxSteps = 10 时，step 8 有提醒、step 7 没有。
  - **token 估算**：`"你好"` 估为 2；`"abcd"` 估为 1；校正比例被夹在 3。
  - **压缩判定**：`shouldCompact` 的边界；`compactionPlan` 保留最近 4 轮；`acceptSummary("short", 10000 字符)` 为 false；1 次失败后紧接的 1 轮跳过、2 轮后放行。
  - **耗时**：`estimateTokens` 处理 200 万个中文字符 < 200ms。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): 上下文构建、压缩、配对守卫与尾部提醒等管线阶段`。

### Task 10: 单步模型调用：流式、看门狗、重试与降级

**Files:**
- Create: `packages/kernel/src/runtime/model-call.ts`、`packages/kernel/test/runtime/model-call.test.ts`
- Modify: `packages/kernel/src/config/schema.ts`（`runtime.*`）、`docs/config.md`

**Interfaces:**
- Consumes：`ProviderRegistry.resolve`（Task 6）、`EventLog`（Task 7）、Task 9 的 `buildModelRequest`、压缩相关函数、`calibrate`。
- Produces：
  - 配置项：
    - `runtime.maxSteps` 默认 50；
    - `runtime.maxRunSeconds` 默认 900；
    - `runtime.streamIdleMs` 默认 60000；
    - `runtime.maxOutputTokens` 默认 16000；
    - `runtime.compactionThreshold` 默认 0.8；
    - `runtime.keepRecentTurns` 默认 4；
    - `runtime.workerConcurrency` 默认 10；
    - `runtime.orgConcurrency` 默认 10。
    - 以上都写 meta；`runtime.orgConcurrency` 可热更，需在 `HOT_APPLIERS` 中登记。
  - `type StreamSink = (delta: { kind: "text" | "thinking" | "step_reset"; runId: string; step: number; text?: string }) => void`。
  - `interface ModelStepDeps { db: KernelDb; eventLog: EventLog; registry: ProviderRegistry; config: () => KernelConfig; log: Logger }`。
  - `class RunError extends Error { constructor(readonly code: string, message: string) }`：运行级失败，`code` 写入 `run_failed.error.code`。模型错误的 code 为 `model.<kind>`，其余为 `run.<reason>`，例如 `run.agent_unavailable`。
  - `runModelStep(deps: ModelStepDeps, input: { conversationId: string; runId: string; step: number; agent: AgentDefinition; agentVersion: number; signal: AbortSignal; sink: StreamSink }): Promise<ModelStepResult>`，步骤如下：
    1. **幂等**：`EventLog.findByIdem(conv, "assistant:<runId>:<step>")` 已存在时，直接返回该事件对应的结果（`reused: true`），不调用模型。
    2. **读事件**：从日志读取事件（读到当前 `last_seq`）。
    3. **压缩**：`shouldCompact`，且 `!compactionBackoff`，才执行。用主模型发起压缩请求（非流式消费，收集最终文本）：`acceptSummary` 通过 → 写 `compaction_summary`；不通过或出错 → 写 `compaction_failed`，本步按原样继续。
    4. **尾部提醒**：`turnLimitReminder` 有值时，先写 `reminder` 事件（idemKey `reminder:<runId>:<step>`）。
    5. **构建请求**：`buildModelRequest`；写 `model_call` 事件（idemKey `model_call:<runId>:<step>:<attempt>`）。
    6. **流式消费**：增量经 `sink` 推出。看门狗：两次事件之间超过 `info.streamIdleTimeoutMs ?? runtime.streamIdleMs` → 本地 abort，并按 `ModelError("timeout")` 处理。外部 `signal` 触发时，把已流出的文本组装成 `{ content: [{type:"text", text}], stopReason: "aborted" }` 写入日志并返回 `aborted: true`。
    7. **降级梯子**：`retryable` 错误先在同一模型上重试一次（等待 `retryAfterMs ?? 1000`，可被 abort），再切到 `agent.fallback`（若配置了）；每次尝试都写自己的 `model_call` 事件（`attempt` 递增，`fallback` 标记）。重试前通过 `sink` 发 `step_reset`。非可重试错误或梯子用尽 → 抛 `RunError(code, message)`，code 取自 ModelError 的 kind，例如 `model.rate_limited`。
    8. **成功**：在一个事务里写 `assistant_message`（idemKey `assistant:<runId>:<step>`）与 `usage`。
    - `ModelStepResult = { content: ContentBlock[]; stopReason: StopReason | "aborted"; reused: boolean; aborted: boolean; usage: ModelUsage | null }`。
  - **单轮收尾**：`runFinalWrapUp(deps, input)`——到达步数上限时调用一次：tools 置空，并在末尾追加 `reminder` `"Step limit reached. Do not call tools. Summarize what you found and what remains for the user."`（spec 6：轮次额度收尾）。

- [ ] **Step 1: 写失败测试**（用 `model-fake`；需要可控行为时，在测试内实现一个 `ModelProvider` 桩）：
  - 流式增量经 sink 拼起来等于最终文本；日志写入 `model_call`、`assistant_message`、`usage` 各一条。
  - 同一 (run, step) 调用两次 → 第二次 `reused: true`，桩供应商只被调用一次。
  - **看门狗（Review Focus 4）**：`stall` 模型配置 `streamIdleTimeoutMs: 200`，并配置兜底模型 → 约 200ms 后重试、再次 stall、切到兜底模型并成功；共 3 条 `model_call` 事件，第 3 条 `fallback: true`；sink 收到 2 次 `step_reset`；总耗时 < 2s。`streamIdleTimeoutMs: 5000` 的推理模型在 300ms 内不触发。
  - `fail:auth` → 不重试，抛 `RunError("model.auth")`。
  - `fail:rate_limited` 且没有兜底模型 → 重试一次后抛错。
  - **中止**：`slow:100` 流到一半时 abort → 日志里的 `assistant_message` 的 stopReason 为 `aborted`、文本为已流出部分；之后不再写 `model_call`。
  - **压缩（Review Focus 5）**：fake 模型 contextWindow 设为 2000，事件填到约 1800 token → 先写 `compaction_summary`，再写 `model_call`，且其 `summarySeq` 指向摘要；下一步不再压缩。压缩请求返回过短的摘要（用桩模拟）→ 写 `compaction_failed`，本步仍完成；下一轮跳过压缩（只有一条 failed 事件）。
  - 提醒：`maxSteps: 3` 时，step 1 写入 `reminder`，且 `model_call.request.reminderSeqs` 包含它。
  - 收尾：`runFinalWrapUp` 发出的请求 `tools` 为空，且末尾是收尾提醒。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**；`pnpm gen:config-docs`。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): 单步模型调用（流式、看门狗、重试与降级、压缩、收尾）`。

### Task 11: 运行编排：队列、会话锁、组织配额、中止、插话与优雅停机

**Files:**
- Create: `packages/kernel/src/runtime/{run-queue,run-worker,conversation-lock,quota,abort,loop}.ts`、`packages/kernel/test/runtime/{run-worker,quota,conversation-lock}.test.ts`
- Modify: `packages/kernel/src/kernel.ts`（创建内核运行队列，按角色决定是否启动 worker；停机流程接入）、`conversations.service.ts`（发消息后调用 `ensureRun`）、`conversations.controller.ts`（`POST …/abort`）、`errors.ts`

**Interfaces:**
- Consumes：`createQueue`、`createLock`、`createBus`（M0，namespace `kernel`）；`EventLog`、`ConversationsService`；Task 10 的 `runModelStep`、`runFinalWrapUp`。
- Produces：
  - `loop.ts`——AgentLoop 接口（spec 4.4）：
    ```ts
    export interface LoopContext {
      conversationId: string; runId: string; agent: AgentDefinition; agentVersion: number;
      signal: AbortSignal; sink: StreamSink;
      /** 下一个步骤间隙要吸收的插话：返回 seq > afterSeq 的 user_message。 */
      pendingUserMessages(afterSeq: number): Promise<ConversationEvent[]>;
      limits: { maxSteps: number; deadline: number };
    }
    export type LoopOutcome =
      | { kind: "completed" | "max_steps" | "max_duration"; consumedUpToSeq: number }
      | { kind: "aborted" }
      | { kind: "interrupted" };   // 停机：已在步骤边界保存好 checkpoint，任务需要回到队列
    export interface AgentLoop { run(ctx: LoopContext): Promise<LoopOutcome> }
    ```
    本任务的测试使用一个简单的 `SequentialLoop`（逐步调用 `runModelStep`，直到 stopReason 不是 `tool_use`），放在测试文件中；Task 12 用 LangGraph 实现替换。
  - `ConversationLock(redis)`：`acquire(conversationId, runId, ttlMs = 30000): Promise<Lease | null>`，键 `capk:conv-run:<id>`，值为 runId，持有期间本地每 `ttlMs/3` 续租；`holder(conversationId): Promise<string | null>`。
  - `OrgQuota(redis)`：
    - `tryEnter(orgId, runId, limit, leaseMs = 60000): Promise<boolean>`——Lua：先 `ZREMRANGEBYSCORE` 清理过期成员，再看计数是否小于 limit，满足则 `ZADD`，并对整个键设 `PEXPIRE leaseMs*2`；
    - `renew(orgId, runId, leaseMs)`、`leave(orgId, runId)`。
    - 单个组织的上限来自 `deployment_settings` 中的 `runConcurrencyOverrides: Record<orgId, number>`（没有则用 `runtime.orgConcurrency`）；`SettingsService` 的 schema 增加这个键。
  - `RunAbort(redis, bus)`：`request(runId, byAccountId)` 设置 `capk:run-abort:<runId>` EX 3600 并发布 `run.abort`；`watch(runId, onAbort): Promise<() => Promise<void>>` 订阅广播，并在订阅后立即检查键一次，避免竞态。
  - `RunQueue`：队列名 `runs`（实际为 `cap-kernel-runs`）。
    - `ensureRun(conversationId): Promise<string | null>`：读 `consumed_seq` 与最新 `user_message` 的 seq；有未消费的消息且 `ConversationLock.holder` 为空时，插入 `runs` 行（status `queued`）并投递任务，jobId 为 `run-<conversationId>-<maxUserSeq>`（同一触发点只会投递一次），返回 runId；否则返回 null。
    - BullMQ 配置：`attempts: 1`；worker 的 `lockDuration` 30000，`maxStalledCount` 3。
  - `RunWorker` 的任务处理流程（`kernel` 命名空间队列的 handler）：
    1. 读取 run 与会话；run 已是终态 → 直接返回。
    2. `ConversationLock.acquire` 失败 → 任务延迟 1s 后再处理（`moveToDelayed` 加 `DelayedError`）。
    3. `OrgQuota.tryEnter` 失败 → 释放锁，延迟 2s 后再处理。
    4. 首次开始时写 `run_started`（idemKey `run_started:<runId>`），把 `runs.status` 改为 `running`。
    5. 调用 `loop.run(ctx)`：`signal` 由 `RunAbort.watch` 与 `deadline` 共同驱动。
    6. 按 outcome 收尾：
       - `completed` / `max_steps` / `max_duration` → 写 `run_finished`，`UPDATE conversations SET consumed_seq = GREATEST(consumed_seq, $consumed)`，status `completed`；
       - `aborted` → 写 `run_aborted`，status `aborted`，同时把 `consumed_seq` 推进到中止时已吸收的位置；
       - `interrupted` → 任务回到队列（延迟 0），不写终态事件；
       - 异常 `RunError` → 写 `run_failed`，status `failed`。
    7. `finally`：释放配额与锁；然后调用 `ensureRun(conversationId)`，处理运行期间到达、但没被吸收的消息（Review Focus 2）。
  - **插话**：`pendingUserMessages` 由 loop 在每个步骤开始前调用；吸收的消息由 `buildModelRequest` 自然纳入（它们本来就是日志中的 `user_message`）。loop 记录吸收到的最大 seq，作为 `consumedUpToSeq`。
  - **优雅停机**（spec 8.5）：内核 `stop()` 的插件阶段之前新增 `runs` 阶段（预算从插件阶段的 15s 中划出 10s）：对本进程正在执行的运行发出 `shutdown` 信号（与用户中止不同）→ loop 在下一个步骤边界返回 `interrupted` → 任务回到队列。超出预算仍未结束的运行交给 BullMQ 的 stalled 机制，由其他 worker 续跑。
  - `POST /api/v1/orgs/:orgId/conversations/:id/abort`（会话所有者）：存在活跃运行时调用 `RunAbort.request` → 202 `{ runId }`；没有活跃运行时返回 409 `run.not_active`。`errors.ts` 追加 `"run.not_active": 409`。

- [ ] **Step 1: 写失败测试**（真实 PG / Valkey、`model-fake`、`SequentialLoop`）：
  - `conversation-lock.test.ts`：A 持有时 B `acquire` 返回 null；A 进程「崩溃」（停止续租）后 30s TTL 到期，B 拿到锁（测试中把 TTL 设为 300ms）；续租可以延长持有。
  - `quota.test.ts`：limit 2 时第 3 个 `tryEnter` 返回 false；不 `leave`、等租约过期后可以进入（崩溃不泄漏）；`runConcurrencyOverrides` 对某个组织生效、其他组织不受影响。
  - `run-worker.test.ts`：
    - 发一条 `echo:hi` 消息 → 事件序列依次为 `user_message`、`run_started`、`model_call`、`assistant_message`、`usage`、`run_finished`，`consumed_seq` 等于该 user 消息的 seq，`runs.status` 为 `completed`。
    - **同一会话串行**：连发两条消息 → 两条都被处理，且两轮运行的事件不交错。
    - **Review Focus 2**：消息在运行 `run_finished` 写入之后、锁释放之前到达（用测试钩子暂停 worker）→ 由 `finally` 中的 `ensureRun` 触发新一轮，消息恰好被回复一次；消息在步骤之间到达（`slow` 模型的两步之间）→ 被本轮吸收，不再另起一轮。
    - **组织配额隔离**：组织 A 的 limit 为 1，同时发起 3 个会话；组织 B 发 1 个 → B 立即开始执行，A 的 3 个依次执行。
    - **中止（Review Focus 3）**：用两个内核实例（同进程、各自独立的 Redis 连接）。运行在 worker 实例上，在另一个实例上调用 abort 接口 → 运行在 1s 内结束，日志里有 `stopReason: "aborted"` 的 `assistant_message` 和 `run_aborted`，此后不再出现 `model_call`。
    - **超时**：`maxRunSeconds: 1` 加上 `slow:500` 的长输出 → `run_finished` 的 reason 为 `max_duration`。
    - **步数上限**：fake 模型连续返回 `tool:noop:{}`（M2 没有工具，测试用的 loop 把 `tool_use` 当作继续）且 `maxSteps: 3` → 调用 `runFinalWrapUp`，`run_finished` 的 reason 为 `max_steps`。
    - **优雅停机**：运行进行中对 worker 内核调用 `stop()` → 任务回到队列；另起一个 worker 内核继续执行并完成，日志中只有一条 `run_started`、一条 `run_finished`。
    - **api 角色不执行运行**：`roles: ["api"]` 的内核接收消息后，运行由另一个 `roles: ["worker"]` 内核执行。
  - `conversations.http.test.ts`：没有活跃运行时 abort → 409 `run.not_active`；别人的会话 → 404。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**；全量全绿（生命周期测试不能回归）。
- [ ] **Step 5: 提交** `feat(kernel): 运行编排（队列、会话锁、组织配额、中止、插话、优雅停机）`。

### Task 12: LangGraph 默认 loop 与崩溃续跑

**Files:**
- Create: `packages/kernel/src/runtime/langgraph-loop.ts`、`packages/kernel/test/runtime/langgraph-loop.test.ts`
- Modify: `packages/kernel/src/kernel.ts`（默认 loop 改为 `LangGraphLoop`）、`run-worker.ts`（运行结束后调用 `pruneToLatest`）

**Interfaces:**
- Consumes：`AgentLoop` / `LoopContext`（Task 11）、`KyselyCheckpointSaver`（Task 8）、`runModelStep`、`runFinalWrapUp`（Task 10）、`guardToolPairs`（Task 9）。
- Produces：`class LangGraphLoop implements AgentLoop`，构造参数 `(saver: KyselyCheckpointSaver, stepDeps: ModelStepDeps)`。
  - **状态**：`{ step: number; consumedUpToSeq: number; lastStopReason: StopReason | "aborted" | null }`。消息不放进状态，每步从事件日志重建，checkpoint 只记录进度。
  - **图**：
    - `prepare` 节点：调用 `pendingUserMessages(consumedUpToSeq)` 推进 `consumedUpToSeq`；`step + 1`；检查 `deadline`。
    - `model` 节点：调用 `runModelStep`。
    - 路由：
      - `stopReason === "tool_use"` → `tools` 节点（M2 中为占位：写一条 `reminder` 事件 `"Tools are not available yet."` 后回到 `prepare`）；
      - `step >= maxSteps` → `wrapUp` 节点（`runFinalWrapUp`）→ 结束；
      - `aborted` → 结束；
      - 其他 → 结束。
  - `thread_id = runId`；`run(ctx)` 先用 `saver.getTuple` 判断有没有已存在的 checkpoint：有则 `invoke(null, config)` 续跑，否则以初始状态启动。
  - **停机信号**：在 `prepare` 节点检查，命中时抛 `GraphInterrupt`（或用 LangGraph 的 `interrupt` 机制）→ 返回 `{ kind: "interrupted" }`；checkpoint 停在当前节点之前。
  - **续跑时的增量**：如果续跑的是 `model` 节点，先发 `step_reset` 增量，让 UI 丢弃此前流出的半截内容。

- [ ] **Step 1: 写失败测试**：
  - 与 Task 11 相同的端到端场景改用 `LangGraphLoop` 后通过（复用 Task 11 的测试辅助函数，把 loop 作为参数传入）。
  - **`resume after crash mid-step`（Review Focus 1）**：`slow:200` 流到一半时，让第一个 worker 内核进程硬退出（模拟方式：在子进程中运行，复用双副本工具 `replica-runner`，`SIGKILL`）→ 第二个 worker 在 stalled 检测后（测试把 `lockDuration` 设为 1000ms）领取任务，从 checkpoint 续跑。验证：
    - 该 (run, step) 恰好一条 `assistant_message`；
    - 只有一条 `run_started`，且 `run_finished` 存在；
    - 监听频道的测试客户端收到了 `step_reset`。
  - **步骤边界之后崩溃**：在 `assistant_message` 已写入、checkpoint 尚未保存时崩溃（在测试钩子中于 `runModelStep` 返回后抛错退出）→ 续跑时复用已有回复（`reused: true`），不再调用模型（桩供应商的调用计数不增加）。
  - 运行结束后 `lg_checkpoints` 中该 thread 只剩 1 行。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): LangGraph 默认 loop 与崩溃续跑`。

### Task 13: 流式推送（SSE）

**Files:**
- Create: `packages/kernel/src/runtime/stream.controller.ts`、`packages/kernel/test/runtime/stream.http.test.ts`
- Modify: `run-worker.ts`（`sink` 把增量发布到 Redis）、`api.module.ts`

**Interfaces:**
- Consumes：`EventLog.readAfter`、bus 主题 `conv.<id>`（Task 7）、`StreamSink`（Task 10）。
- Produces：
  - 增量发布：worker 的 `sink` 把 `{ kind: "delta", runId, step, delta: "text" | "thinking" | "step_reset", text? }` 发布到 `kernel` bus 主题 `conv.<conversationId>`（与 `{ kind: "events", toSeq }` 共用同一频道）。
  - `GET /api/v1/orgs/:orgId/conversations/:id/stream?after=<seq>`（`@OrgAction("agents.use")`，仅会话所有者可用）：
    - 响应头 `content-type: text/event-stream`、`cache-control: no-cache`、`x-accel-buffering: no`；
    - 先订阅频道，再回放 `readAfter(after)`，每条事件发 `event: event`、`data: <ConversationEvent JSON>`、`id: <seq>`；之后收到 `events` 通知就读取并发送新事件（按 seq 去重，只发 seq 大于已发送值的）；收到 `delta` 就发 `event: delta`；
    - 支持 `Last-Event-ID` 请求头（优先于 `after`）；
    - 每 15s 发一次 `: ping` 注释作为心跳；
    - 连接关闭时退订并清理定时器；
    - 每个请求实时复核权限（在连接建立时；长连接期间每 60s 复核一次，失败就关闭流）。
  - 在 Nest + Fastify 下用 `@Res()` 直接写原始响应，绕过拦截器的缓冲。

- [ ] **Step 1: 写失败测试**（真实 HTTP 监听，用 `fetch` 读取流）：
  - 连接后发一条 `echo:hello world` 消息 → 依次收到 `user_message` 事件、多个 `delta`、`assistant_message` 事件、`run_finished` 事件，且 `delta` 文本拼起来等于回复。
  - `after=<seq>` 只回放其后的事件；带 `Last-Event-ID` 断线重连时不重复、不遗漏。
  - **跨副本**：运行在副本 A，SSE 连在副本 B（两个内核实例，`roles` 分别为 `["worker"]` 与 `["api"]`）→ B 收到全部增量与事件。
  - 15s 心跳（用假时钟或 `heartbeatMs` 测试参数）。
  - 会话所有者被移出组织后，60s 复核时流被关闭（测试参数设为 200ms）。
  - 未登录 → 401；别人的会话 → 404。
  - 公开路由元测试不需要修改。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(kernel): 会话 SSE 流式推送`。

### Task 14: `anthropic` 供应商插件

**Files:**
- Create: `plugins/anthropic/{package.json,src/index.ts,src/map-request.ts,src/map-stream.ts,src/errors.ts,test/fixtures.ts,test/map.test.ts,test/conformance.test.ts}`

**Interfaces:**
- Consumes：Task 4 的全部类型；`describeModelProviderConformance`、`startFakeModelServer`。
- Produces：插件 `@capybara-hq/plugin-anthropic`（name `anthropic`），提供 `model-provider@1`。
  - **部署配置**：`{ apiKey: secret(z.string()), baseUrl?: string, models: string[] /* 允许的模型 id，默认 ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] */, serverFallbacks: z.enum(["default", "off"]).default("default") }`。
  - **`listModels()`**：调用 `client.models.retrieve(id)` 获取每个允许的模型，结果缓存在 `ctx.kv`（TTL 3600）。字段映射：
    - `contextWindow` ← `max_input_tokens`；`maxOutputTokens` ← `max_tokens`；
    - capabilities：`tools: true`；`vision`、`reasoning` 依据 `capabilities` 字段；`caching: true`；`midConversationSystem` 依据模型白名单（Opus 5 及以后、Sonnet 5.5、Haiku 5.5、Fable 系列为 true）；`effort: true`；
    - `streamIdleTimeoutMs: 300000`（思考阶段可能长时间不发事件）。
  - **`map-request.ts`**：
    - system 块 → `system: [{ type: "text", text, cache_control: cache ? { type: "ephemeral" } : undefined }]`；
    - 消息 → `Anthropic.MessageParam[]`：
      - thinking 块：仅当 `opaque.provider === "anthropic" && opaque.model === req.model` 时原样回放 `opaque.data`（含签名），否则丢弃；
      - `role:"system"`：模型支持时按原样（`{ role: "system", content }`），否则转成 user 文本 `"[system] …"`；
    - `thinking: { type: "adaptive" }`；`output_config: { effort }`（如果有）；
    - `max_tokens: req.maxOutputTokens`；
    - tools 映射为 `{ name, description, input_schema, eager_input_streaming: true }`，`tool_choice` 不设置（即默认 auto）；
    - `serverFallbacks === "default"` 且模型属于 Opus 5.5 / Opus 5 / Fable 5.1 / Sonnet 5.5 时，走 beta 接口并带 `betas: ["server-side-fallback-2026-07-01"]`、`fallbacks: "default"`。
  - **`map-stream.ts`**：用 `client.messages.stream(...)`（或 beta 版）：
    - `content_block_delta` 的 `text_delta` → `text_delta`；`thinking_delta` → `thinking_delta`；
    - 结束时 `finalMessage()` → `message_complete`：
      - thinking 块写入 `opaque: { provider: "anthropic", model, data: <原始块> }`；
      - tool_use → `tool_call`（`input` 用 `JSON.parse` 解析，解析失败 → `ModelError("invalid_request")`）；
      - `stop_reason` 映射：`end_turn` / `tool_use` / `max_tokens` / `refusal`，其他 → `other`；
      - usage：`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`。
  - **`errors.ts`**：SDK 的异常类映射为 `ModelError`：
    - `RateLimitError` → `rate_limited`（`retryAfterMs` 来自 `retry-after`）；
    - 529 / `OverloadedError` → `overloaded`；其他 5xx → `server`；
    - `AuthenticationError` / `PermissionDeniedError` → `auth`；
    - `BadRequestError` → `invalid_request`，其中提示超出上下文的 → `context_overflow`；
    - `APIConnectionTimeoutError` → `timeout`；`APIConnectionError` → `network`；`APIUserAbortError` → `aborted`。
    - 只用类型判断，不匹配错误信息字符串（context_overflow 除外：用 SDK 返回的错误 `type` 字段判断）。
  - SDK 客户端 `maxRetries: 0`（重试由内核的降级梯子统一处理）。

- [ ] **Step 1: 写失败测试**：
  - `map.test.ts`：
    - 带 `cache: true` 的 system → 有 `cache_control`；
    - 其他模型产生的 thinking opaque 不回放；同一模型的原样回放；
    - 不支持中途 system 的模型 → 转成 user 文本；
    - 请求中没有 `budget_tokens`，没有 `thinking.type === "disabled"`，没有 `tool_choice`；
    - 客户端工具带 `eager_input_streaming: true`；
    - `fallbacks: "default"` 与对应 beta 只出现在白名单模型上。
  - `conformance.test.ts`（夹具模式）：`startFakeModelServer` 按 Anthropic 的 SSE 格式（`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`）回放 `test/fixtures.ts` 中手写的各场景夹具；`expect: { thinking: true, caching: true }`。另外测 429 → `rate_limited` 且带 `retryAfterMs`、529 → `overloaded`、401 → `auth`。
  - **真实接口模式**：设置了环境变量 `CAPYBARA_TEST_ANTHROPIC_API_KEY` 时，用 `claude-haiku-5-5` 跑同一套一致性测试；未设置时用 `describe.skipIf` 跳过，并在输出中注明。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**；在 README 的插件说明中写明配置示例。
- [ ] **Step 4: 运行确认通过**（夹具模式；有密钥时也跑真实接口模式，并在报告中记录结果）。
- [ ] **Step 5: 提交** `feat(plugins): anthropic 供应商插件（原生 Messages API）`。

### Task 15: `openai` 供应商插件

**Files:**
- Create: `plugins/openai/{package.json,src/index.ts,src/map-request.ts,src/map-stream.ts,src/errors.ts,test/fixtures.ts,test/map.test.ts,test/conformance.test.ts}`

**Interfaces:**
- Consumes：同 Task 14。
- Produces：插件 `@capybara-hq/plugin-openai`（name `openai`），提供 `model-provider@1`。
  - **部署配置**：`{ apiKey: secret(z.string()), baseUrl?: string, organization?: string, models: { id: string; contextWindow: number; maxOutputTokens: number; reasoning: boolean; vision: boolean; streamIdleTimeoutMs?: number }[] /* 必填，至少 1 个 */ }`。`listModels()` 直接由配置生成（`caching: true`；`midConversationSystem: true`，以 `developer` 角色实现；`effort` 与 `reasoning` 相同）。
  - **`map-request.ts`**：生成 Responses API 的 `input` 项：
    - system 块合并为 `instructions`（缓存是自动的，不需要标记）；
    - user → `{ role: "user", content: [{ type: "input_text", text }] }`；
    - assistant text → `{ role: "assistant", content: [{ type: "output_text", text }] }`；
    - thinking 块：仅当 `opaque.provider === "openai"` 且模型相同时，回放原始的 reasoning 项（含 `encrypted_content`）；
    - tool_call → `{ type: "function_call", call_id, name, arguments }`；tool_result → `{ type: "function_call_output", call_id, output }`；
    - `role:"system"` → `{ role: "developer", content }`；
    - 固定参数 `store: false`、`include: ["reasoning.encrypted_content"]`；推理模型带 `reasoning: { effort }`（`xhigh` / `max` 映射为 `high`）；`max_output_tokens`。
  - **`map-stream.ts`**：`client.responses.stream(...)`：
    - `response.output_text.delta` → `text_delta`；推理摘要的增量 → `thinking_delta`；
    - `response.completed` → `message_complete`：reasoning 项写入 opaque；`function_call` → `tool_call`（`arguments` 用 `JSON.parse` 解析）；
    - stopReason：有 function_call → `tool_use`；`incomplete_details.reason === "max_output_tokens"` → `max_tokens`；内容过滤 → `refusal`；其余 → `end_turn`；
    - usage：`input_tokens`、`output_tokens`、`input_tokens_details.cached_tokens` → `cacheReadTokens`；`cacheWriteTokens` 为 0。
  - **`errors.ts`**：
    - `RateLimitError` → `rate_limited`；`InternalServerError` → `server`；
    - `AuthenticationError` / `PermissionDeniedError` → `auth`；
    - `BadRequestError` → `invalid_request`，错误 `code === "context_length_exceeded"` 的 → `context_overflow`；
    - `APIConnectionTimeoutError` → `timeout`；`APIConnectionError` → `network`；`APIUserAbortError` → `aborted`；
    - 客户端 `maxRetries: 0`。

- [ ] **Step 1: 写失败测试**：
  - `map.test.ts`：请求含 `store: false` 与 encrypted_content 的 include；其他供应商的 opaque 不回放；中途 system → developer；`xhigh` → `high`；tool_result → `function_call_output`。
  - `conformance.test.ts`（夹具模式）：按 Responses API 的 SSE 事件格式（`response.created`、`response.output_text.delta`、`response.completed` 等）编写夹具；`expect: { thinking: true, caching: true }`。另外测 429、401、`context_length_exceeded` 的映射。
  - **真实接口模式**：设置了 `CAPYBARA_TEST_OPENAI_API_KEY` 与 `CAPYBARA_TEST_OPENAI_MODEL` 时运行；否则跳过。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交** `feat(plugins): openai 供应商插件（原生 Responses API）`。

### Task 16: Web 骨架：Next 应用、登录与 i18n key 同步检查

**Files:**
- Create:
  - `apps/web/{package.json,next.config.ts,tsconfig.json}`
  - `apps/web/src/app/[locale]/{layout,page}.tsx`、`apps/web/src/app/[locale]/{login,setup}/page.tsx`
  - `apps/web/src/app/api/[...path]/route.ts`
  - `apps/web/src/lib/{api,session}.ts`、`apps/web/src/i18n/{routing,request}.ts`、`apps/web/messages/{zh,en}.json`
  - `apps/web/test/{api,login}.test.tsx`
  - `tools/checks/src/i18n.ts`、`tools/checks/test/i18n.test.ts`、`tools/checks/fixtures/i18n/{missing-key,extra-key}/`
- Modify: 根 `package.json`（`check` 加入 `check:i18n`；`pnpm dev:web` 脚本）、`pnpm-workspace.yaml`（如有需要）、`biome.json`（如需支持 TSX）、`vitest.config.ts`（`apps/web/test/**/*.test.tsx` 使用 jsdom 环境）、`.github/workflows/ci.yml`

**Interfaces:**
- Produces：
  - **代理**：`app/api/[...path]/route.ts` 把 `GET` / `POST` / `PUT` / `PATCH` / `DELETE` 原样转发到 `process.env.CAPYBARA_KERNEL_URL`（默认 `http://localhost:8080`）的 `/api/<path>`。请求头透传（去掉 `host`、`connection`）；响应头与状态码透传，`set-cookie` 逐条透传；响应体以流的形式透传（`new Response(upstream.body, …)`），不缓冲，保证 SSE 可用。导出 `export const dynamic = "force-dynamic"`。
  - **API 客户端** `lib/api.ts`：
    - `apiFetch<T>(path: string, init?: RequestInit): Promise<T>`：非 GET 自动带 `X-Capybara-Csrf: 1`；
    - 收到 401 `auth.token_expired` 时调用 `POST /api/v1/auth/refresh` 一次再重试；
    - 失败时抛 `ApiClientError { status, code, message }`。
  - **i18n**：`next-intl`，路由前缀 `/zh`、`/en`，默认 `zh`。所有界面文案通过 `useTranslations` 读取，组件中不出现硬编码的中文或英文界面文案。
  - **页面**：
    - `/[locale]/setup`：调用初始化向导（`GET` / `POST /api/v1/setup`）；
    - `/[locale]/login`：本地登录；
    - `/[locale]`：已登录时显示「当前组织」选择（`GET /api/v1/me`）与 agent 列表（Task 17 填充），未登录时跳转到 login。
  - **检查** `checkI18n(messagesDir: string): Finding[]`：
    - 以 `zh.json` 为基准，`en.json` 缺少的 key → `rule: "i18n-missing-key"`，多出的 key → `rule: "i18n-extra-key"`；
    - 每条信息给出 key 的完整点路径和修正方法：`在 en.json 中补上该 key` 或 `删除该 key`；
    - CLI 为 `pnpm check:i18n`，扫描 `apps/web/messages`。
  - **CI**：新增 job `web`，执行 `pnpm --filter @capybara-hq/web build`。

- [ ] **Step 1: 写失败测试**：
  - `i18n.test.ts`：`missing-key` fixture 恰好产生 1 条 `i18n-missing-key`，且点路径正确；`extra-key` 产生 1 条 `i18n-extra-key`；`apps/web/messages` → 0 条。
  - `api.test.ts`（jsdom，用 msw 或手写的 fetch 桩）：POST 带了 CSRF 头；401 `token_expired` → refresh 一次后重试成功；refresh 失败 → 抛 `ApiClientError`。
  - `login.test.tsx`：提交表单调用了 `POST /api/v1/auth/login`；错误码 `auth.invalid_credentials` 显示为翻译后的文案（zh 和 en 各断言一次）。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过；证明检查会红**：临时删掉 `en.json` 中的一个 key → `pnpm check` 失败并点名该 key；恢复后通过。`pnpm --filter @capybara-hq/web build` 成功。手工验证：启动内核和 `pnpm dev:web`，在浏览器中完成初始化与登录。
- [ ] **Step 5: 提交** `feat(web): Next 网页骨架、登录与 i18n key 同步检查`。

### Task 17: 网页聊天

**Files:**
- Create: `apps/web/src/app/[locale]/agents/{page,new/page}.tsx`、`apps/web/src/app/[locale]/chat/[conversationId]/page.tsx`、`apps/web/src/components/{AgentForm,ChatView,MessageList,Composer}.tsx`、`apps/web/src/lib/stream.ts`、`apps/web/test/{stream,chat}.test.tsx`、`apps/web/e2e/chat.spec.ts`、`apps/web/playwright.config.ts`
- Modify: `apps/web/messages/{zh,en}.json`、`.github/workflows/ci.yml`（Playwright job）

**Interfaces:**
- Consumes：Task 6、7、11、13 的端点；Task 16 的 `apiFetch` 与代理。
- Produces：
  - **`lib/stream.ts`**：`openConversationStream(orgId, conversationId, afterSeq, handlers: { onEvent(e: ConversationEvent); onDelta(d) }): () => void`。基于 `EventSource`；断线时浏览器自动重连并带上 `Last-Event-ID`；返回关闭函数。
  - **会话状态归约** `reduceChat(state, input)`（纯函数）：
    - 事件按 seq 合入，重复的忽略；
    - `delta` 累积到「当前步骤的流式草稿」中；收到 `step_reset` 时清空草稿；收到对应 step 的 `assistant_message` 事件时，用它替换草稿；
    - `run_started` 之后、终态事件之前，视为运行中。
  - **页面**：
    - agent 列表（`GET /orgs/:orgId/agents`）；
    - 新建 agent 表单：模型下拉框来自 `GET /models`，兜底模型可选；保存后显示 `warnings`（例如「兜底模型应来自另一家供应商」）；
    - 聊天页：消息列表 + 输入框。运行中输入框不禁用，此时发送即为插话；运行中显示「停止」按钮，调用 abort 接口；`stopReason === "aborted"` 的消息显示「已停止」标记。
  - **e2e**（Playwright，chromium）：测试启动 Testcontainers 的 PG / Valkey、一个加载 `model-fake` 的内核和 `next dev`，跑通流程：
    1. 初始化向导 → 建组织 → 新建 agent（模型 `model-fake / fake-1`）；
    2. 发送 `echo:hello capybara` → 页面逐步出现 `hello capybara`；
    3. 发送 `slow:300:` 加一段长文本，运行中点「停止」→ 显示「已停止」，部分文本保留；
    4. 再发送 `slow:200:` 加一段文本，运行中再发一条 `echo:interject` → 两条消息都得到回复，且插话的回复出现在第一条回复之后；
    5. 刷新页面 → 历史完整。

- [ ] **Step 1: 写失败测试**：
  - `stream.test.ts`：`reduceChat` 在乱序、重复的事件下结果正确；`step_reset` 清空草稿；`assistant_message` 替换草稿。
  - `chat.test.tsx`：运行中显示「停止」按钮并调用 abort；已停止的消息带标记（zh 与 en 文案各断言一次）。
  - `e2e/chat.spec.ts`：上面的 5 个步骤。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**；CI 新增 Playwright job（安装 chromium，运行 `pnpm --filter @capybara-hq/web e2e`）。
- [ ] **Step 4: 运行确认通过**（单测加 e2e）；`pnpm check`（i18n 检查）全绿。
- [ ] **Step 5: 提交** `feat(web): 网页聊天（流式、插话、停止）`。

### Task 18: 双副本验收、技能与文档

**Files:**
- Create: `packages/testing/test/m2-acceptance.test.ts`、`skills/writing-model-providers/SKILL.md`、`.changeset/<随机名>.md`
- Modify:
  - `packages/testing/src/dual-replica.ts`（`kill(index)`、`replicaOf(response)`）
  - `README.md`（快速开始：用 `model-fake` 不需要密钥即可在网页上对话；`anthropic` / `openai` 的配置示例）
  - `AGENTS.md`、`skills/writing-plugins/SKILL.md`
  - `docs/superpowers/plans/{2026-10-17-mvp-roadmap,2026-10-17-m1-followups,2026-10-17-m0-followups}.md`

**Interfaces:**
- Produces：
  - 双副本工具新增：`Harness.kill(index: 0 | 1): Promise<void>`（对子进程 `SIGKILL`，之后发往该副本的请求抛错）；`Harness.request` 的返回值附带 `replica: 0 | 1`（通过响应头 `x-capybara-replica`，副本 runner 在测试模式下设置）。
  - 技能 `writing-model-providers`（frontmatter `name: writing-model-providers`，`description` 写「新建或修改模型供应商插件时使用」），内容包括：
    - `model-provider@1` 契约；
    - 原生协议的原则：用官方 SDK，不经兼容层转译；
    - opaque 回放规则：只回放给同一供应商、同一模型；
    - 错误映射表；
    - 不在插件内重试（SDK 设 `maxRetries: 0`）；
    - `streamIdleTimeoutMs` 的取值；
    - 如何用 `startFakeModelServer` 编写夹具、如何启用真实接口模式；
    - 「模型或网关补丁只放在插件里，并写明何时可以删除」。
  - `AGENTS.md` 的规则速记新增两条：
    - 运行时：「事件日志是唯一事实源，模型看到的一切都进日志，历史只追加」，指向内核 runtime 目录；
    - 模型供应商：指向 `skills/writing-model-providers`。
  - `m1-followups.md`：把已处理的条目移到「M2 已处理」小节，注明对应提交；同时修正 M1 留下的文档措辞问题（`m0-followups` 中 Task 11 那一行、提交列改为哈希、核实或删除 AGENTS.md 中未核实的说法）。
  - 路线图中 M2 行标注完成。
  - changeset：`@capybara-hq/kernel` minor、`@capybara-hq/plugin-sdk` minor、`@capybara-hq/testing` minor、新插件 `@capybara-hq/plugin-model-fake` / `plugin-anthropic` / `plugin-openai` 各 minor。`@capybara-hq/web` 是私有包，不加 changeset（R26 一并处理）。

- [ ] **Step 1: 写失败测试** `m2-acceptance.test.ts`（双副本；插件为 `model-fake`；`config` 设置较短的 `lockDuration` 与 stalled 检测间隔，具体参数项由 Task 11 / 12 暴露）：
  1. 初始化向导 → 建组织 → 建 agent。
  2. 在一个副本上打开 SSE，在另一个副本上发送 `echo:first` → SSE 收到完整回复与 `run_finished`。
  3. 发送 `slow:300:` 加一段长文本，`assistant_message` 出现之前，`kill` 正在执行运行的那个副本（通过 `runs` 与日志中的 worker 标识判断；双副本角色都含 worker）。
  4. 存活的副本续跑完成：同一 (run, step) 恰好一条 `assistant_message`；SSE 客户端（如果它连在被杀的副本上，就按 `Last-Event-ID` 重连到存活的副本）最终看到 `run_finished`，并收到过 `step_reset`。
  5. 在存活副本上继续发送 `echo:after-crash` → 正常回复，证明会话锁与配额没有泄漏。
  6. 校验对 `assistant_message` 的模型调用次数：被杀的那一步最多被调用两次，其余每步一次（从 `model_call` 事件统计）。
- [ ] **Step 2: 运行确认失败**（`kill` 不存在）。
- [ ] **Step 3: 实现**双副本工具的扩展；编写技能与文档；更新 followups 与路线图。
- [ ] **Step 4: 运行确认通过**；全量 `pnpm lint && pnpm typecheck && pnpm check && pnpm test` 全绿，且 web 的 e2e 通过。手工按 README 快速开始执行一遍：起依赖与内核（加载 `model-fake`）和 `pnpm dev:web`，在浏览器里完成初始化、建 agent、对话、停止和插话。
- [ ] **Step 5: 提交** `test: M2 双副本端到端验收（杀 worker 续跑），补充模型供应商技能与文档` 并附 changeset。

---

## 执行顺序与依赖

```
T1 鉴权收尾 ─ T2 组织收尾 ─ T3 HTTP/生命周期/Nacos
T4 model-provider 契约 ─ T5 model-fake ─┬─ T6 Agent ─ T7 会话日志 ─┐
                                        │                           ├─ T9 上下文 ─ T10 模型调用 ─ T11 运行编排 ─ T12 LangGraph loop ─ T13 SSE
                                        └─ T8 checkpointer ─────────┘
T14 anthropic、T15 openai（依赖 T4，可在 T5 之后任意位置）
T16 Web 骨架 ─ T17 网页聊天（依赖 T13）
T18 验收（依赖全部）
```

按编号顺序执行：T1–T3 都改内核 identity / http 相关文件，先做完避免后续冲突；T6、T7、T10、T11、T13 都往 `api.module.ts`、`errors.ts`、`config/schema.ts` 追加内容，必须串行。
