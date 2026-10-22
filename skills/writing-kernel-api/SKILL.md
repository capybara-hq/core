---
name: writing-kernel-api
description: 给内核新增或修改 HTTP API（Nest controller、guard、错误码）时使用：领域类不依赖 Nest 并用 useFactory 注入、构造参数显式 @Inject、默认拒绝与 @Public 清单、@OrgAction 与 HUMAN_ONLY、ZodPipe、错误码登记、多副本下状态放哪里，以及用 http.inject() 写测试的模板。
---

# 写内核 HTTP API

内核 HTTP 是 **NestJS + Fastify**（`packages/kernel/src/http/`）。只有内核用 Nest：**插件不依赖 Nest**，插件路由仍是 `ctx.http.route(method, path, (req: Request) => Promise<Response>)`（见 `skills/writing-plugins`）。

参考实现：`packages/kernel/src/orgs/`（`orgs.controller.ts` + `members.service.ts` + `org.guard.ts`）。

## 分层：领域类不依赖 Nest

| 层 | 写在哪 | 规则 |
|---|---|---|
| 领域服务 | `src/<领域>/*.service.ts` 或同类文件 | 普通 class，**不加任何 Nest 装饰器、不 import `@nestjs/*`**；依赖（`KernelDb`、`Redis`、其他服务）走构造参数 |
| 注入令牌 | `src/http/tokens.ts` | 每个服务一个 `Symbol`，带一行 JSDoc 说明对应类型 |
| 装配 | `src/http/api.module.ts` 的 `serviceProviders()` | `{ provide: TOKEN, useFactory: (db: KernelDb) => new XxxService(db), inject: [KERNEL_DB] }` |
| controller | `src/<领域>/*.controller.ts`，加进 `CONTROLLERS` | 只做参数解析、鉴权声明、调用服务、设 Cookie；业务规则写在服务里 |

领域类不依赖 Nest，单元测试直接 `new XxxService(db)`，CLI（如 `capybara admin create`）也能复用。

## 构造参数必须显式 `@Inject`

```ts
@Controller("api/v1/widgets")
export class WidgetsController {
  constructor(
    @Inject(WIDGETS) private readonly widgets: WidgetsService,
    @Inject(KERNEL_CONFIG) private readonly config: () => KernelConfig,
  ) {}
}
```

原因：仓库开 `experimentalDecorators`，**不开 `emitDecoratorMetadata`**；tsx / esbuild 与 Vitest 也不产出设计期类型元数据。Nest 拿不到参数类型，漏写 `@Inject` 会在应用初始化时报「Nest can't resolve dependencies」。guard 同理（`@Inject(Reflector)`、`@Inject(KERNEL_DB)`）。用 tsx 跑内核的入口要加载仓库的 `tsconfig.base.json`（根脚本 `--tsconfig tsconfig.base.json`），否则装饰器无法编译。

## 鉴权：默认拒绝

全局 `AuthGuard`（`APP_GUARD`）对**所有**路由默认要求凭据（Bearer API 令牌，或会话 Cookie `cap_at`；会话是否已吊销先看 Redis 标记、再以 PG `sessions.revoked_at` 为准，Redis 丢数据不会让已吊销的会话复活）；经 Cookie 认证的非安全方法（POST / PUT / PATCH / DELETE）要求 CSRF 头 `X-Capybara-Csrf: 1`，Bearer 不检查。每个请求实时读账号状态，停用账号 403 `auth.account_disabled`。按需叠加装饰器：

| 装饰器 | 含义 |
|---|---|
| `@Public()` | 不要求凭据（有凭据仍会解析成 principal；凭据无效即 `ApiError` 时按未携带处理，PG / Redis 故障等其他异常照常 500）。公开路由的非安全方法无论是否带 Cookie 都要求 `X-Capybara-Csrf: 1` |
| `@SessionOnly()` | 只接受 Web 会话，如令牌管理、改密码：个人令牌 → 403 `auth.session_required`，服务令牌 → 403 `forbidden` |
| `@EnterpriseAdmin()` | 只允许企业管理员；服务令牌一律 403 |
| `@AllowService()` | 允许服务令牌（服务 principal 默认被拒） |
| `@OrgAction(action)` | 组织级路由，见下 |
| `@CurrentPrincipal()` | 参数装饰器，取 principal；需要人类用户时调 `requireUser(p)` |

**加 `@Public()` 路由必须同时更新 `packages/kernel/test/identity/public-routes.test.ts` 的 `PUBLIC_ROUTES` 清单**，否则元测试失败。这道测试枚举全部路由、不带凭据逐一请求，保证没有路由意外公开；它还挂了一个探针 `APP_INTERCEPTOR`，清单外的路由只要 handler 被执行（守卫没拒绝）就判失败——handler 里自己补抛 `auth.required` 掩盖不了误标的 `@Public()`。公开路由必须是真的无需登录的入口（登录、刷新、邀请、初始化），而且要考虑限流与枚举攻击。

### 凭据尝试限流（`RATE_LIMITER`）

`LoginRateLimiter`（`src/identity/rate-limit.ts`），计数在 Redis、窗口 900s，校验凭据**之前**先原子占用一次额度，成功后退还：

- 登录 `reserve(login, ip)` / `succeeded(login, ip)`：（登录名, IP）10 次、IP 50 次、单登录名跨 IP 100 次，任一已达上限即 429 `auth.rate_limited`（带 `Retry-After`），且被拒绝的尝试**不递增任何计数**（Lua 先查后增）。攻击者从自己的 IP 打满某登录名，不影响本人从别的 IP 登录。
- 其他核对凭据的接口用 `reserveScoped(scope, key, ip, limit, ipLimit = 50)` / `succeededScoped(scope, key, ip)`，键为 `capk:rl:<scope>:…`，与登录的 IP 额度分开。现有 scope：`acct`（改密码，按账号 id 10 次）、`setup`（初始化令牌，全部署 100 次、单 IP 10 次）、`inv`（接受邀请，按令牌 10 次、单 IP 20 次）。新增核对凭据 / 令牌的公开入口照此接入。

### `@OrgAction` 与 `HUMAN_ONLY`

组织级路由路径里必须有 `:orgId`，声明动作即可，不要在 controller 里自己查成员：

```ts
@Patch(":orgId/members/:accountId")
@OrgAction("org.members.manage")
async changeRole(@CurrentPrincipal() p: Principal, @CurrentOrg() org: OrgContext, ...) {}
```

- 动作与最低角色在 `src/orgs/roles.ts` 的 `ACTION_MIN_ROLE`（guest < member < admin < owner）；新动作在这里登记。
- `OrgGuard` 每个请求实时从 PG 读组织与角色：组织不存在 / 已删除 / 调用者不是成员 → 一律 404 `org.not_found`（不泄露组织是否存在）；角色不足 → 403 `forbidden`。
- `@OrgAction` 隐含 `@AllowService()`；`HUMAN_ONLY` 里的动作（除 `org.read`、`org.members.read`、`agents.use` 之外的全部）遇到服务令牌返回 403。
- **依赖角色的写操作要在事务里重读角色**：guard 的判定与写入之间角色可能被改。服务事务里调 `lockOrgAndAuthorize(trx, orgId, actorAccountId, action)`（`src/orgs/org-lock.ts`）：`SELECT … FROM capybara.orgs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE` 锁组织行，再读发起人当前角色；组织不存在 / 已删除 → 404 `org.not_found`，非成员或角色不足 → 403 `forbidden`，返回 `{ org, role }` 供进一步判断（如令牌 / 邀请角色不得高于发起人）。只需串行化、不看角色时用 `lockOrg` / `tryLockOrg`。服务只收发起人账号 id，不收调用方传入的角色。
- **企业管理员写操作同理**（`@EnterpriseAdmin` 只是请求开头的判定）：撤销 / 停用账号、新建账号（含企业管理员）、改部署设置都在事务内先调 `lockEnterpriseAdminsAndAuthorize(trx, actorAccountId)`（`src/identity/enterprise-admin.ts`）：取 `pg_advisory_xact_lock(hashtext('capybara.enterprise_admins'))` 串行化，并在锁内确认发起人仍是活跃企业管理员，否则 403 `forbidden`。新增企业管理员写操作必须照做。
- **管理员给自己降级是允许的行为**：`PATCH /orgs/:orgId/members/:self`（admin → member / guest）照常成功并写 `org.member.role_changed` 审计；只有授予 / 撤销 / 改动 owner 才要求发起人是 owner，且任何操作都不能让组织没有 owner（`org.last_owner`）。降级后该账号立刻失去 `org.members.manage`，后续请求由 OrgGuard 实时判定。
- **依赖「成员关系仍然存在」的写入先锁关系行**：如 `PUT /me/current-org` 在一个事务里先 `FOR SHARE` 组织行、再 `SELECT … FROM memberships WHERE org_id = $1 AND account_id = $2 FOR SHARE`（只查这一条），再写会话；加锁顺序必须与「移出成员」一致（组织行 → 成员关系行），否则会死锁。
- **令牌过期时间**用 `identity/api-tokens.ts` 导出的共享 schema `FutureIsoDate`（完整 ISO 8601 datetime 字符串且晚于当前时间；数字、`"2099-01-01"` 之类 → 400）。
- **组织插件配置**（`OrgPluginConfigs`）：`get` / `list` 在 `REPEATABLE READ` 只读事务里读配置行与密钥；`enabled=false` 的插件 `get` 不校验、返回 `{ enabled: false, config: null }`；`put` 同一事务内清掉当前 schema 里已不存在的密钥路径对应的 `capybara.secrets` 行；从未配置时 `config` 列存 NULL。

### 现有的组织动作（M6 起）

`connectors.manage`（admin）/ `connectors.use`（guest）是 D17 改名后的连接器动作（原 `apps.*`，HTTP `/api/v1/orgs/:orgId/connectors*`，错误码 `connector.*`；不留 `/apps` 别名与兼容层，C28）。M6 新增：

| 动作 | 最低角色 | 用在 |
|---|---|---|
| `trajectories.read` | member | 轨迹查看器；服务里再判定「组织管理员或该 agent 的负责人」，评测对话只给组织管理员，其余一律 404 |
| `evals.manage` | admin | 评测集、用例、运行、标注 |
| `org.models.manage` | admin | 本组织的模型用途映射（`/model-purposes`） |
| `directory.read` | member | 组织视角的企业目录；`POST directory/:itemId/install` 路由只要这一项，服务在组织行锁内按种类再复核 `skills.manage` / `connectors.manage` / `org.plugins.manage`（应用三者都要） |
| `directory.request` | member | 成员申请目录条目 |
| `directory.decide` | admin | 组织管理员决定成员申请 |

以上都在 `HUMAN_ONLY` 里（服务令牌 403）。新动作照此在 `roles.ts` 登记并写一行注释说明用途。

旧审计记录 `app.*` 不改写；按 action 查询审计时用 `auditActionAliases`（`identity/audit.ts`）的显式映射把新旧名当同义（不按前缀猜）。

### 企业管理员端点（`/api/v1/admin/*`）

部署级端点一律放在 `/api/v1/admin/*`，controller 上加 `@EnterpriseAdmin()`（服务令牌一律 403），称呼一律「企业管理员」（代码标识 `@EnterpriseAdmin`、路径 `/admin` 不改名，C1）。写操作在事务里先 `lockEnterpriseAdminsAndAuthorize`（见上）。现有：

| 路径 | controller | 内容 |
|---|---|---|
| `overview`、`accounts*`、`orgs`、`settings`、`models`、`model-prices`、`model-purposes*` | `admin/admin.controller.ts` | 概览、账号、组织、部署设置（`deployment_settings`：`orgCreation`、`runConcurrencyOverrides`、`sandboxLimitOverrides`、`priceCurrency`、`customConnectors`、`customSkills`）、模型、价格、部署默认的用途映射 |
| `plugins*` | `admin/plugins.controller.ts` | 插件列表与详情、部署级配置（`:name/config`）、批准、安装 / 启用 / 停用 / 卸载、包上传（`packages/file`）与 npm 导入（`packages/npm`） |
| `directory*` | `directory/admin-directory.controller.ts` | 目录导入（`import/file`、`import/npm`）、应用包 `apps/prepare/*` → `apps/:stagingId/confirm`、条目列表 / 详情 / 图标 / 策略 / 删除、插件条目装到部署 |
| `directory/requests*` | `directory/org-directory.controller.ts` | 待企业管理员决定的目录申请 |
| `catalogs*` | `directory/catalogs.controller.ts` | 官方 / 企业清单的增删改、刷新、浏览条目、从清单引入 |

- 企业管理员默认**读不到对话**：轨迹与评测只给组织管理员与 agent 负责人（C1），不要在 `/admin` 下加读对话内容的端点。
- 包上传路由收原始字节（`application/octet-stream`，上限 `packages.maxBytes`，在 Fastify 里单独放宽 bodyLimit）；网页层代理另有自己的上限 `CAPYBARA_WEB_MAX_PACKAGE_BYTES`，见 `docs/config.md`。
- CLI 复用同一批领域类（`capybara admin grant|revoke <login>`、`capybara plugins …`），所以领域类不能依赖请求上下文。

### 审计与个人令牌

写操作在同一事务里调 `audit(trx, { actorAccountId, actorTokenId?, orgId?, action, target?, detail? })`。请求来自个人令牌时把令牌 id 记进 `actor_token_id`：controller 用 `patTokenId(requireUser(p))`（Web 会话返回 undefined）取值，作为服务方法末尾的可选参数 `actorTokenId` 传下去。`detail` 不得含令牌、密码等机密。

### 现行的凭据行为

- 改密码（`PUT /me/password`，`@SessionOnly`）：核对旧密码前占用限流额度（scope `acct`：按账号 id 10 次、按客户端 IP 50 次，与登录额度分开，超限 429 `auth.rate_limited`）；成功后吊销该账号**除当前会话外的所有 Web 会话**，并**吊销其全部个人访问令牌**（R24）；新密码、会话 `revoked_at` 与令牌吊销在同一个 PG 事务内（`AccountsService.changePassword`），Redis 吊销标记随后尽力写入。
- 停用账号（`PATCH /admin/accounts/:id`）与吊销其全部会话、个人令牌在同一个 PG 事务内完成（`AccountsService.updateAccount`），Redis 吊销标记在提交后尽力写入（鉴权以 PG `revoked_at` 为准）。
- 初始化向导与凭邀请注册时，会话行与账号 / 组织 / 成员关系在同一事务内写入（`SessionService.create(accountId, meta, trx)`），Cookie 在提交之后才设置；新增「建账号即登录」的流程照此办理。
- 列表接口一律返回信封对象（如 `{ tokens: [...] }`、`{ members: [...] }`），不返回裸数组；分页的列表附 `next`（下一页游标，作为 `after` 传回，没有更多时为 null），如 `GET /admin/accounts`。

## 参数校验：`ZodPipe`

```ts
const Body = z.object({ name: z.string().min(1).max(100) });

@Post()
async create(@Body(new ZodPipe(Body)) body: z.infer<typeof Body>) {}
```

校验失败返回 400 `validation_failed`，`details` 为字段问题列表。字符串都给上限（`max`），防止超长输入。

## 错误码

- 业务错误抛 `new ApiError(code, message)`（`src/errors.ts`）；新码先登记到 `ERROR_CODES`（码 → HTTP 状态），命名 `<领域>.<snake>`。
- `message` **一律英文**；界面以 `code` 为 key 走 i18n。不要把密钥、密码哈希、内部异常信息放进 `message` / `details`。
- 响应信封统一为 `{ error: { code, message, details? } }`，由 `http/error.filter.ts` 生成；框架自身的错误（Nest `HttpException`、Fastify 的请求体过大 / 媒体类型不支持等）按该文件里的状态码表映射成通用码：400 `validation_failed`、401 `auth.required`、403 `forbidden`、404 `not_found`、409 `conflict`、413 `payload_too_large`、415 `unsupported_media_type`、429 `rate_limited`，表外一律 `internal`；未知异常一律 500 `internal`，不回显。
- 5xx 会记日志，路径经 `redactPath` 脱敏（邀请令牌段换成 `:token`，任何 `cap_` 开头的段换成 `:redacted`）；不要在日志字段里另外放原始 URL 或令牌。

## 多副本：状态放哪里

生产多副本，同一用户的连续请求会落在不同进程。

| 状态 | 放哪里 |
|---|---|
| 账号、会话、成员角色、邀请等持久数据 | PG（`KERNEL_DB`），每个请求实时读，**不缓存在进程内存** |
| 限流计数、短期标记 | Redis（`KERNEL_REDIS`），键前缀 `capk:`，**必须带 TTL**；「检查再写入」要用 Lua 原子完成 |
| 并发互斥 | PG 行锁 / 咨询锁（如初始化向导用 `pg_advisory_xact_lock`） |
| 配置 | 注入 `KERNEL_CONFIG`（`() => KernelConfig`），每次调用取当前值，热更新才生效 |

不得用进程内 Map、定时器、本地事件保存跨请求状态。双副本验收测试（`packages/testing/test/m1-acceptance.test.ts`）会暴露这类缺陷。

## 测试模板

单副本 HTTP 测试用 `kernel.http.inject()`（Fastify light-my-request，不占端口）+ `packages/kernel/test/helpers/http.ts` 的 Cookie 罐：

```ts
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { asUser, cookieJar } from "../helpers/http.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
}, 120_000);
afterAll(async () => {
  await k?.stop();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

it("未登录访问被拒，登录后可访问", async () => {
  expect((await k.http.inject({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
  // 准备账号（如 new AccountsService(kernelDb(db)).createLocal(...)）后：
  const req = asUser(k.http, cookieJar()); // 自动带 cookie 与 X-Capybara-Csrf: 1，收下 set-cookie
  const login = await req({ method: "POST", url: "/api/v1/auth/login", payload: { login: "u", password: "pw" } });
  expect(login.statusCode).toBe(200);
  expect((await req({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(200);
});
```

要点：

- 断言错误时同时断言状态码与 `error.code`。
- 每个新端点至少覆盖：未登录、角色不足 / 非成员（404）、服务令牌（若有 `@OrgAction`）、校验失败、成功路径。
- 并发与跨副本行为（竞态、登出后另一副本即时失效等）用 `@capybara-hq/testing` 的 `createDualReplicaHarness`（`config` 选项可深合并内核配置，如 `{ auth: { cookieSecure: false } }`），参考 `packages/testing/test/m1-acceptance.test.ts`。

## 清单

1. 领域服务（无 Nest）+ 单元测试。
2. `tokens.ts` 加令牌，`api.module.ts` 加 `useFactory` provider 与 controller。
3. controller：构造参数 `@Inject`、鉴权装饰器、`ZodPipe`；新错误码登记 `errors.ts`。
4. 新 `@Public()` 路由 → 更新 `public-routes.test.ts`。
5. 新配置项按 `skills/adding-config`；新表按 `skills/writing-migrations`。
6. `pnpm lint && pnpm typecheck && pnpm check && pnpm test`；影响发布的改动加 changeset。
