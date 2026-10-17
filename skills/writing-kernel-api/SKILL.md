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
| `@Public()` | 不要求凭据（有凭据仍会解析成 principal）。公开路由的非安全方法无论是否带 Cookie 都要求 `X-Capybara-Csrf: 1` |
| `@SessionOnly()` | 只接受 Web 会话，如令牌管理、改密码：个人令牌 → 403 `auth.session_required`，服务令牌 → 403 `forbidden` |
| `@EnterpriseAdmin()` | 只允许企业管理员；服务令牌一律 403 |
| `@AllowService()` | 允许服务令牌（服务 principal 默认被拒） |
| `@OrgAction(action)` | 组织级路由，见下 |
| `@CurrentPrincipal()` | 参数装饰器，取 principal；需要人类用户时调 `requireUser(p)` |

**加 `@Public()` 路由必须同时更新 `packages/kernel/test/identity/public-routes.test.ts` 的 `PUBLIC_ROUTES` 清单**，否则元测试失败。这道测试枚举全部路由、不带凭据逐一请求，保证没有路由意外公开。公开路由必须是真的无需登录的入口（登录、刷新、邀请、初始化），而且要考虑限流与枚举攻击。

### `@OrgAction` 与 `HUMAN_ONLY`

组织级路由路径里必须有 `:orgId`，声明动作即可，不要在 controller 里自己查成员：

```ts
@Patch(":orgId/members/:accountId")
@OrgAction("org.members.manage")
async changeRole(@CurrentPrincipal() p: Principal, @CurrentOrg() org: OrgContext, ...) {}
```

- 动作与最低角色在 `src/orgs/roles.ts` 的 `ACTION_MIN_ROLE`（guest < member < admin < owner）；新动作在这里登记。
- `OrgGuard` 每个请求实时从 PG 读组织与角色：组织不存在 / 已删除 / 调用者不是成员 → 一律 404 `org.not_found`（不泄露组织是否存在）；角色不足 → 403 `forbidden`。
- `@OrgAction` 隐含 `@AllowService()`；`HUMAN_ONLY` 里的动作（除 `org.read`、`org.members.read` 之外的全部）遇到服务令牌返回 403。
- **依赖角色的写操作要在事务里重读角色**：guard 的判定与写入之间角色可能被改。服务事务里调 `lockOrgAndAuthorize(trx, orgId, actorAccountId, action)`（`src/orgs/org-lock.ts`）：`SELECT … FROM capybara.orgs WHERE id = $1 AND deleted_at IS NULL FOR UPDATE` 锁组织行，再读发起人当前角色；组织不存在 / 已删除 → 404 `org.not_found`，非成员或角色不足 → 403 `forbidden`，返回 `{ org, role }` 供进一步判断（如令牌 / 邀请角色不得高于发起人）。只需串行化、不看角色时用 `lockOrg` / `tryLockOrg`。服务只收发起人账号 id，不收调用方传入的角色。
- **企业管理员写操作同理**（`@EnterpriseAdmin` 只是请求开头的判定）：撤销 / 停用账号、新建账号（含企业管理员）、改部署设置都在事务内先调 `lockEnterpriseAdminsAndAuthorize(trx, actorAccountId)`（`src/identity/enterprise-admin.ts`）：取 `pg_advisory_xact_lock(hashtext('capybara.enterprise_admins'))` 串行化，并在锁内确认发起人仍是活跃企业管理员，否则 403 `forbidden`。新增企业管理员写操作必须照做。

### 审计与个人令牌

写操作在同一事务里调 `audit(trx, { actorAccountId, actorTokenId?, orgId?, action, target?, detail? })`。请求来自个人令牌时把令牌 id 记进 `actor_token_id`：controller 用 `patTokenId(requireUser(p))`（Web 会话返回 undefined）取值，作为服务方法末尾的可选参数 `actorTokenId` 传下去。`detail` 不得含令牌、密码等机密。

### 现行的凭据行为

- 改密码（`PUT /me/password`，`@SessionOnly`）：核对旧密码前按 `acct:<账号 id>` + 客户端 IP 占用登录限流额度（与登录同窗口、同上限，超限 429 `auth.rate_limited`）；成功后吊销该账号**除当前会话外的所有 Web 会话**，**不吊销个人令牌**（PAT 需用户在 `/me/tokens` 自行吊销）。
- 停用账号（`PATCH /admin/accounts/:id`）同时吊销其全部会话与个人令牌。
- 列表接口一律返回信封对象（如 `{ tokens: [...] }`、`{ members: [...] }`），不返回裸数组。

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
