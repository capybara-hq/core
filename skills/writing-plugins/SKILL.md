---
name: writing-plugins
description: 在 plugins/* 下新建或修改 Capybara 插件时使用：清单字段、权限清单与批准（capybara plugins review / approve、pluginPermissions.autoApprove）、能力取用 ctx.capabilities 与 orgScoped、部署级 / 组织级 / 渠道连接配置、ctx 各项的用法、多副本下禁止的写法（定时器、模块级状态）及替代方案，以及用双副本工具写测试的模板。往网页加界面（ctx.ui）见 writing-plugin-ui。
---

# 写插件

参考实现：`plugins/example-counter`（db 事务 + queue 幂等任务 + provide，直接复制它起步；kv 的用法见下文「持久计数与幂等的写法」）。模型供应商插件（`model-provider@2`）另见 `skills/writing-model-providers`；给 agent 提供工具（`ctx.tools`）或连接器（`connector@1`）另见 `skills/writing-tools`；IM 渠道、第三方登录、通讯录（`channel@1` / `identity-source@1` / `directory@1`）另见 `skills/writing-channels`（参考 `plugins/slack`、`plugins/lark`）；往网页加界面（`ctx.ui`：渲染 schema 视图与嵌入应用）另见 `skills/writing-plugin-ui`（参考 `plugins/todo`、`plugins/example-board`）。

## 硬约束（先看这个）

| 规则 | 检查 | 规则 id |
|---|---|---|
| 只能 import `@capybara-hq/plugin-sdk`、`zod`、其他第三方 npm 包；**不能** import `@capybara-hq/kernel` 或插件目录之外的文件。测试里可以用 devDependency `@capybara-hq/testing` | `pnpm check:deps` | `plugin-imports-kernel`、`plugin-imports-outside` |
| 不得使用 `setTimeout` / `setInterval` / `setImmediate` / `node:timers` | `pnpm check:plugin-state` | `plugin-timer` |
| 模块顶层不得有 `let` / `var` / `new Map/Set/WeakMap/WeakSet` / 数组字面量 | `pnpm check:plugin-state` | `plugin-module-state` |
| `setup(ctx)` 里用到的 `ctx.secrets` / `ctx.storage` / `ctx.http.route` / `ctx.tools.register` / `ctx.capabilities` / `ctx.ui.view` / `ctx.ui.action` 必须在清单里声明；`ctx.models` 尚未提供 | `pnpm check:plugin-permissions` | `perm-secrets`、`perm-storage`、`perm-http`、`perm-tools`、`perm-capability`、`perm-ui`、`perm-reserved` |
| `ctx.kv` 写入必须带 `ttlSeconds`（类型层强制） | `pnpm typecheck` | — |
| 队列名、job id 不含 `:`（BullMQ 限制） | 运行时：`ctx.queue.define` / `add` 直接抛 `TypeError` | — |

`pnpm check` 一次跑全部。

### 为什么禁定时器与模块级状态

生产是多副本，写入方和读取方可能不在同一个进程。进程内的 Map / 定时器只存在于创建它的那个进程：别的副本读不到、停不掉。dev 单进程测不出来，所以要在写代码时就避开。

| 想做的事 | 别这样 | 这样 |
|---|---|---|
| 跨请求共享状态 | 模块顶层 `Map` | 持久数据 `ctx.db`；临时/会过期的状态 `ctx.kv`（带 TTL） |
| 延迟 / 周期任务 | `setTimeout` / `setInterval` | `ctx.queue.add(name, data, { delayMs })` |
| 单次请求内可中止的等待（退避、流式间隔、超时） | `setTimeout` 包 Promise | `AbortSignal.timeout(ms)`，与调用方的 `signal` 一起监听（见 `plugins/model-fake` 的 `defaultSleep`） |
| 通知其他副本 | 进程内事件 / 回调表 | `ctx.bus.publish` / `subscribe` |
| 「谁开谁关」的配对 | 开启方在内存里持有句柄 | 开启方自过期（TTL）+ 关闭方广播 |

`AbortSignal.timeout(ms)` 只用于**本次请求内**、随请求结束而结束的等待：它不在请求之外调度任何工作。凡是「过一会儿 / 每隔一段时间再做某事」的需求，不论多短，都走 `ctx.queue`（`delayMs`），因为到点时处理它的可能是另一个副本，发起的进程也可能已经不在了。

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
  optional: [],               // 可选依赖：缺提供方也能加载，取用时 list 为空
  permissions: {              // 权限清单：未声明即禁止，见下
    http: [{ method: "POST", path: "/inc" }],
  },
  config: {
    deployment: z.object({ step: z.number().int().positive().default(1) }), // 部署级
    // org: z.object({...}),                                                // 组织级
  },
  migrations: "../migrations", // 相对入口文件所在目录；src/ 与 dist/ 下都指向包根 migrations/
  setup(ctx) { /* 见下 */ },
});
```

`definePlugin` 在加载时校验清单，不合法直接抛错。

**权限清单（`permissions`）**：内核按清单构造 `ctx`，未声明的平台能力访问抛 `PluginPermissionError`（消息写明要在清单哪一项声明）并记审计 `plugin.permission_denied`。

- 自动授予、无需声明：`kv`、`lock`、`bus`、`queue`、`log`、`db`、`config`、`provide`。
各项（都是治理信息，部署方批准时会看到）：

| 项 | 写法 | 说明 |
|---|---|---|
| `secrets` | `secrets: true` | 才能用 `ctx.secrets` |
| `http` | `[{ method, path, public? }]` | 每条 `ctx.http.route` 都要列出，`method` 为 GET / POST / PUT / DELETE，`path` 以 `/` 开头；`public: true` 表示免登录，会高亮展示。**目前 `public` 只是声明**（Ruling A2）：插件路由不论是否 `public` 都不经内核鉴权，见下文「插件路由的匹配语义」 |
| `tools` | `["write"]` | 每个 `ctx.tools.register` 的工具名（本地名，不含 `<插件名>__` 前缀）；工具能看到会话内容，会高亮展示 |
| `network` | `["api.example.com"]` | 会访问的固定域名，只展示、平台不拦截；端点全由管理员配置时不写；不支持通配 |
| `ui` | `{ views: ["tasks"], embeds: ["board"] }` | 与清单顶层 `ui`（界面贡献）一一对应：kind view 的列进 `views`（记入快照、**不卡加载**），kind embed 的列进 `embeds`（卡加载、要批准、敏感项）。细则见 `skills/writing-plugin-ui` |
| `storage` | `storage: true` | 才能用 `ctx.storage`（对象存储：每个方法第一个参数是 `orgId`（须是 UUID，统一按小写），键自动限定在 `plugins/<插件名>/<orgId>/` 下；键不能为空、不能以 `/` 开头、不能有 `.` / `..` 段、`\`、控制字符与 `${`，加前缀后 ≤ 1024 字节，否则抛 `StorageKeyError`；预签名的 `ttlSeconds` 会被限制在 1..604800；`list` 返回的键已去掉前缀。`presignPut` 返回 `{ method, url, headers, fields? }`：S3 实现是 `POST` 表单直传，大小由存储端限制）；未声明而用了报 `perm-storage`。部署没装 `object-store@1` 提供方（如 `object-store-s3`）时，声明了它的插件**不加载**（pending，原因 dependency） |
| `hooks` / `models` | — | 预留项（尚未提供 `ctx.models`，用了 `check:plugin-permissions` 报 `perm-reserved`） |

**能力取用（`requires` / `optional`）**：`ctx.capabilities.get / list(ref)` 只能取 `requires` / `optional`（或自己 `provides`）里声明的 ref，别的 ref 报 `perm-capability`。只能取直通能力（`channel`、`directory`、`identity-source` 等）；brokered 能力（模型供应商、连接器、沙箱、密钥存储、对象存储）只能经平台能力用，取它直接抛普通 `Error`（声明也解决不了，不记审计）。`requires` 的提供方缺失则本插件不加载；`optional` 缺失照常加载，取用时 `list` 为空、`get` 抛 `CapabilityUnavailableError`。多选能力 `get` 必须给提供方名。

**`orgScoped` 能力与组织变体**：能力登记为 `orgScoped`（`channel`、`directory`；登记表见 `packages/plugin-sdk/src/capability.ts`）表示是否可用取决于组织是否启用了提供方插件。`identity-source` 不是：登录是部署级的，由内核配置 `auth.loginSources` 启用。组织启用插件时，它 `requires` 的每个 `orgScoped` 能力在该组织须至少有一个已启用的提供方（否则 `plugin.dependency_missing`）；停用会让某个已启用插件失去唯一提供方时拒绝（`plugin.has_dependents`，可强制）。不传 `orgId` 是部署级视角、同步返回，不按组织过滤；传 `{ orgId }` 是 async 变体，返回 Promise 并按该组织的启用状态过滤（每次查询、不缓存）：

```ts
// 部署级（setup 里）：同步
const providers = ctx.capabilities.list<Directory>("directory@1");
// 某个组织的视角（调用现场）：async，该组织未启用提供方时 get 会 reject CapabilityUnavailableError
const dir = await ctx.capabilities.get<Directory>("directory@1", "lark", { orgId });
const enabled = await ctx.capabilities.list<Directory>("directory@1", { orgId });
```

**调用上下文原则**：`setup(ctx)` 拿到的是**部署级**上下文，看不到任何组织、账号、会话。内核调用插件实现时把本次的上下文放进调用参数，内容由扩展点决定：工具执行带组织、账号、agent、会话（`ToolCallContext`）；渠道（`channel@1`）带该渠道连接的 `connectionId` 与连接配置（组织、账号由内核按连接与发言人解析，插件看不到）；通讯录带该组织的组织级配置；登录（`identity-source`）带部署级配置与认证请求、不含会话；队列任务只有你入队时写进 job 数据的内容（通常带 `orgId`，内核校验插件在该组织已启用）。所以**不要把组织 / 会话 / 身份存进模块变量或 ctx 的闭包里跨调用传递**，从本次调用的参数里取；需要跨调用保存的会话相关数据写自己的 `ctx.db`。

**静态检查（`pnpm check:plugin-permissions`）**：扫描 `definePlugin({...})` 里 `setup` 的 `ctx` 参数（含本地别名，以及按位置传给**同文件**函数的 ctx，如 `mount(ctx)`），把 `ctx.secrets`、`ctx.http.route(method, path)`、`ctx.tools.register({ name })`、`ctx.capabilities.get|list(ref)`、`ctx.ui.view|action(id)`、`ctx.storage`、`ctx.models` 与清单比对，用了未声明的就失败。路由路径、工具名、能力 ref、界面 id 须写成字符串字面量（或指向同文件 const），动态的值报「Cannot statically confirm」；确属运行时才知道的（且已评审）在该行行尾或紧邻上一行写 `// capybara:allow-dynamic-permission <原因>`，原因不能为空；该注释只放行「无法静态确认」，未声明的字面量访问与 `perm-reserved` 不能豁免。ctx 传给其他文件的函数时检查跟不过去（靠运行时 `PluginPermissionError` 兜底），所以把用平台能力的代码放在 `setup` 同文件里。
**批准**：内核在 PG 记已批准的权限快照（上面各项，加上 provides / requires / optional、配置字段与迁移里 `CREATE TABLE` 的表名）。插件首次出现、或升级后比快照多出任何一项时不加载，`requires` 它的插件同样不加载，企业管理员在后台网页批准（`POST /api/v1/admin/plugins/:name/approve`，带审阅时的 `sha256` 与 `reviewHash`，快照来源 web，免重启：本副本随即加载，其他副本经 `kernel.plugins.changed` 收敛），或用 `capybara plugins review` / `capybara plugins approve <name>` 批准（覆盖配置声明的插件与安装记录；CLI 写完 PG 后经 Redis 发布 `kernel.plugins.changed`，运行中的副本同样免重启加载，发布失败时等下一个周期）；权限变少或不变直接加载。内置插件（`openai-compatible`、`object-store-s3`）预先批准，不进审批。提供 `sandbox@1`、`object-store@1`、`channel@1`、`directory@1`、`identity-source@1` 的插件在审阅页与 CLI 标为敏感（只影响展示）。所以**发版时多要的每一项都会让部署方停下来批准**，别顺手多声明。比快照版本旧的插件（滚动升级中重启的旧副本、或有意回滚）只要权限不超出快照就照常加载，但**快照保留较新版本的内容不缩减**；回滚后旧版本多出的项仍需批准。开发与测试用配置项 `pluginPermissions.autoApprove: true`（环境变量推导规则见 `skills/adding-config`，双副本 harness 默认开启）：启动时自动批准新增或升级多要的权限，仅限开发与试用，生产别开。自动批准同样写快照（来源 auto）并打 warn 日志，但不写审计。

批准的细节：

- `capybara migrate` 与启动时的迁移同样受快照约束：未批准的插件不跑它的迁移（不建表）。`capybara plugins review` 直连 PG，会先执行内核迁移。
- 「多出一项」按条目比较：把路由从 `public` 改成非公开、把配置字段从密钥改成普通字段，也算新条目，需要再批准一次。
- 迁移里的表名靠解析 `CREATE TABLE` 得出，`ALTER TABLE … RENAME`、视图等不进快照，评审时看 SQL。

**`setup` 必须返回**：插件按依赖顺序串行 setup，内核不给 setup 设超时。setup 永不 resolve（如等待一个永远不来的外部连接、`await` 一个没人 resolve 的 Promise）时，内核 `start()` 会**永远挂起**、HTTP 不监听、后续插件不加载；此时停机（`stop()`）仍会立即关闭该插件的 ctx 并释放连接。需要等外部依赖就绪时，在 setup 里自己设超时并抛错，或把等待挪到队列任务里。

**撤销与重新加载（不重启，C17）**：插件实例可能在进程运行中被撤销（停用、卸载、升级换新实例，或它 `requires` / `optional` 的提供方换了实例）。内核为每个实例记一本账：经 ctx 的每项登记——工具、路由、队列 worker、bus 订阅、`ctx.lock` 取到的租约、界面 view / action、`provide`——撤销时逐项撤掉，**插件不用自己退订或释放**。撤销顺序：停止接新调用 → 等在途的工具调用与队列任务结束（最多 `pluginHost.drainSeconds`，默认 30 秒；没结束的工具调用以英文错误结果交给模型，没结束的队列任务被强制留在队列里，锁过期后由新实例**再执行一次**——队列任务本来就是至少一次，handler 必须幂等）→ 中止 `ctx.signal`（排空时限内结束的调用与任务看不到中止）→ 撤销账上各项 → 调用清单里可选的 `dispose(ctx)`（最多 `pluginHost.disposeTimeoutSeconds`，默认 10 秒，超时内核记日志后继续）。所以：自己起的长任务（轮询、长连接）要监听 `ctx.signal` 收尾；在 ctx 之外自建的资源（自己 new 的客户端、连接池）在 `dispose` 里关掉；`dispose` 里不要再经 ctx 登记。撤销或替换时，插件路由上进行中的请求（SSE 等）的 `req.signal` 被中止；之后插件的 `/plugins/<name>/*` 返回 503 `plugin.unavailable`（部署里没有这个插件时才是 404）。运行中重新加载时 setup 最多 `pluginHost.reloadSetupTimeoutSeconds`（默认 60 秒），超时则保留旧实例。旧版本模块代码留在内存直到进程重启，所以**模块级状态不会被重置**——这也是禁用模块级状态的又一个原因。setup 抛错时不调用 `dispose`，已登记的由内核撤销。

`sdk` 范围由内核按 `SDK_VERSION`（等于 `@capybara-hq/plugin-sdk` 的 package 版本，有测试钉住）校验。0.x 阶段 `^0.1.0` 只匹配 `0.1.x`：**SDK 升 minor（如 0.2.0）时，仓库内所有插件的 `sdk` 范围都要同步改**，否则内核拒绝加载。

## 两级配置

- **部署级**（`config.deployment`）：运维在内核配置的 `pluginConfig.<插件名>` 里给（环境变量 `CAPYBARA_PLUGIN_CONFIG` 传 JSON，或逐字段 `CAPYBARA_PLUGIN_CONFIG__<插件名大写、- 换 _>__<字段>`，如 `CAPYBARA_PLUGIN_CONFIG__EXAMPLE_COUNTER__POOL_SIZE=3` 对应 `example-counter` 的 `poolSize`）。标了 `secret` 的部署级字段，其值校验通过后自动加入日志打码集合（嵌套的数组 / 对象展开为其中所有标量；数字转成字符串后打码，布尔不打码；短于 4 个字符的值不打码）。打码只是兜底，**不要主动把密钥写进日志**。内核按 schema 校验，`ctx.config` 是校验后的值；类型是 `unknown`，在 `setup` 里用同一个 schema `parse` 一次拿到类型。
  - **后台也能配（D8 / C10）**：企业管理员在后台（`GET / PUT /api/v1/admin/plugins/<name>/config`，`PUT` 体为 `{ values: { "<字段点路径>": 值 | null } }`，`null` 清除、缺省不变）填的值存 PG `plugin_deployment_configs`，`secret()` 字段各自加密存 `capybara.secrets`（namespace `kernel`、org `_deployment`、键 `plugin-deployment-config:<插件>:<点路径>`），响应只给「已设置」，审计 `plugin.deployment_config_updated` 只记路径。优先级：**环境变量 > 文件 / Nacos > PG > schema 默认值**，按字段合并；启动配置里有的字段在后台只读并显示来源（`env` / `file` / `nacos`），`PUT` 它返回 409 `plugin.config_readonly`。内置、配置声明与安装记录的插件都一样。
  - **不合法 = 待配置，不是启动失败**：部署配置缺必填字段或不合法时插件不加载（副本状态 `pending / config`，后台 `pending_config`），内核照常启动；配好（后台保存或改启动配置后重启）后下一次 reconcile 不重启即加载。依赖它提供的能力的插件随之待定（`dependency`），它加载后一并加载。
  - **`hot` 字段与重新加载**：字段标 `.meta({ hot: true })` 表示插件能在运行中接受新值。保存后各副本经 bus（`kernel.plugin-deployment-config`）重读并校验：只改了 hot 字段时**就地替换**——`ctx.config` 是 getter，**在用时读**（如每次请求时读 `(ctx.config as Cfg).timeoutMs`）才能拿到新值，别在 setup 里把 hot 字段拷进闭包；改了非 hot 字段时内核**重新加载实例**（新的 setup，先新后旧、排空在途调用，见上面「撤销与重新加载」）；新值不合法时保持当前值并告警。丢了消息由周期 reconcile 兜底重读。
- **组织级**（`config.org`）：每个组织各自的启用状态与配置，由组织 admin 通过内核 API（`GET /api/v1/orgs/:orgId/plugins`、`PUT /api/v1/orgs/:orgId/plugins/:plugin`）设置，内核按该 schema 校验并存储，规则见下一节。
- 插件自己运行中产生的密钥（如 OAuth 换来的 token）走 `ctx.secrets`（加密存储），不要放进普通配置。
- **渠道连接配置**（`channel@1` 的 `connectionSchema`）是第三种：一个组织可以建多个渠道连接，每个连接一份（bot 凭据等），由组织管理员在网页「渠道」里填写，密钥字段同样用 `secret()`、加密存储、只回显「已设置」；内核在调用 `verify` / `connect` / `send` 时把校验后的值作为 `config` 传入。
- 选哪一级：只有部署方能决定、全部署共用一份的（登录的 client id / secret、平台地址）放部署级；每个组织各自的（通讯录凭据）放组织级；每个 bot 一份的放渠道连接配置。凭据都经配置由内核传入时插件不需要 `permissions.secrets`（Slack、Lark 插件都没有声明）。
- **组织级配置里某项能力的字段可选时**（同一插件提供多种能力，组织只用其中一些），用该能力提供的「是否已配置」钩子告诉内核，而不是在调用时返回空结果：如 `Directory.configured(orgConfig)` 返回 false 时内核把通讯录视为未配置、不扫描不同步（详见 `skills/writing-channels`）。它必须是纯函数。

### 组织级配置与 `secret()` 字段的存储与回显

- 敏感字段用 `secret(schema)` 标记（`import { secret } from "@capybara-hq/plugin-sdk"`）。内核用 `configFields` 遍历 `config.org`，`meta.secret` 为真的叶子按点路径（如 `webhook.token`）识别为密钥字段。对象上标 `secret` 对其全部后代叶子生效。
- **只支持对象路径**：`secret()` 只能标在从根经对象字段（及 `default` / `prefault` / `optional` / `nullable` / `readonly` / `catch` 包装）可达的节点上。标在 union / discriminatedUnion / intersection / transform / pipe / lazy / 数组元素 / record 值 / tuple 等内部的 `secret()`（`config.org` 与 `config.deployment` 都算）会让**插件加载失败**，错误点名插件与路径（如 `plugin x: config.org: secret() at "auth<union#1>.token" ...`）。需要时把外层整个对象字段（或整个数组字段）标 `secret`，它的值作为一个整体加密存储。
- 存储：非密钥部分（校验后的值，含默认值）存 `capybara.plugin_org_configs.config`；每个密钥字段单独加密存 `capybara.secrets`（命名空间 `kernel`、键 `plugin-config:<插件名>:<点路径>`，值为 JSON 编码），与配置行在同一事务内写入。`kernel` 因此是保留插件名。
- 回显：API 响应的 `config` 永远不含密钥字段，只给 `secrets: [{ path, set }]` 表示是否已设置；审计只记 `{ enabled, changedPaths }`。
- 更新（`PUT` 的 `config`）：非密钥字段整体替换为传入值；密钥字段**缺省 = 保留原值**、`null` = 清除、其他值 = 新值。合并后的完整对象再用 schema 校验，失败返回 `plugin.config_invalid`，`details` 为 `{ path, message }[]`（不回显值）。只传 `enabled: true` 时也会校验现存配置，不满足 schema 不能启用。
- 打码：组织级配置的密钥值在写入（`PUT`，事务提交后）与解密读取时由该副本加入单独的有界打码集合（最多 10000 个，满了淘汰最早的）；来源是组织管理员，只登记长度 ≥ 12 的值，且只在日志字段里打码、不动日志消息，防止租户遮蔽其他租户的日志。
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
| `ctx.tools` | 给 agent 提供工具 | `register(spec, handler)` 只能在 `setup` 里调用；模型可见名 `<插件名>__<spec.name>`；**只在启用了本插件的组织可用**（组织 admin `PUT /api/v1/orgs/:orgId/plugins/<name> {"enabled": true}`），未启用时运行时按不可用工具处理。描述与错误文案规则、默认策略、`ToolError`、`InputRequired` 见 `skills/writing-tools`，参考 `plugins/todo` |
| `ctx.ui` | 对话页右侧标签 / 顶栏「扩展」里的组织页面 | `view` / `action`（渲染 schema 视图，只能在 `setup` 里注册，`render` 与 `action` 必须响应 `signal`、5 秒超时）、`invalidate`（经 bus 跨副本刷新）、`verifyEmbedToken`（嵌入应用的数据路由先验令牌）。写法、积木、上限与嵌入应用的安全规则见 `skills/writing-plugin-ui`，参考 `plugins/todo`、`plugins/example-board` |
| `ctx.storage` | 文件、大对象（按组织隔离） | 需清单 `permissions.storage`（`perm-storage`）；每个方法第一个参数是 `orgId`，键落在 `plugins/<插件名>/<orgId>/` 下，别的插件、内核（`kernel/<orgId>/`）互相看不到。浏览器上传用 `presignPut`（返回 `{ method, url, headers, fields? }`，按 `method` 发 PUT 或 POST 表单），下载用 `presignGet`（用户上传的内容只对图片 / PDF 用 `inline`）；组织删除后它的对象由内核定期清掉。没有存储提供方时插件不加载。写存储提供方见 `skills/writing-object-store-providers` |
| `ctx.secrets` | 按组织存取密钥 | 加密落库 |
| `ctx.config` / `ctx.log` | 部署配置 / 日志 | `ctx.config` 是 getter，hot 字段在用时读；日志里不要打印密钥 |

### 连接器（`connector@1`）

`provides: [CONNECTOR_CAPABILITY]`，`setup` 里 `ctx.provide(CONNECTOR_CAPABILITY, connector)`，把一类远端服务接成组织里的「应用」（工具快照、凭据、审批都由内核管）。连接器是部署级的，不需要按组织启用。要点：会话按次打开、用完关闭，不缓存连接；每个出站请求前调用 `auth()`；401 → `onUnauthorized()` 后重试一次；不跟随重定向；不把凭据写进错误与日志。详见 `skills/writing-connectors`，参考 `plugins/connector-mcp`、`plugins/connector-openapi`。

### 沙箱与对象存储（`sandbox@1` / `object-store@1`）

两者都是单选、中转能力：一个部署只装一个提供方，别的插件不能 `requires`，由内核取用（沙箱经 `SandboxService` 与内置的
`sandbox_*` 工具，存储经 `ctx.storage` 与内核功能）。提供方只实现原语，生命周期、锁、前缀隔离、清理都在内核。详见
`skills/writing-sandbox-providers`（参考 `plugins/sandbox-docker`、`plugins/sandbox-e2b`）与
`skills/writing-object-store-providers`（参考 `plugins/object-store-s3`）。

### 渠道、登录、通讯录（`channel@1` / `identity-source@1` / `directory@1`）

一个 IM 平台的插件通常三种都提供：`setup` 里分别 `ctx.provide(CHANNEL_CAPABILITY, …)`、`ctx.provide(IDENTITY_SOURCE_CAPABILITY, …)`、`ctx.provide(DIRECTORY_CAPABILITY, …)`。渠道与通讯录要在组织启用插件后才可用，登录经内核配置 `auth.loginSources` 启用。长连接（含多副本选主）、入站去重与持久排队、出站续投、卡片操作的授权都由内核做，插件只管协议转换。要点：三处的身份键 `<插件名>:<租户 id>` + 平台用户 id 必须一致；`onEvent` resolve 后才向平台确认；转义模型文本防 @所有人；通讯录列不全必须抛错。详见 `skills/writing-channels`，参考 `plugins/slack`、`plugins/lark`。

### 插件路由的匹配语义（`ctx.http.route`）

签名固定：`ctx.http.route(method, path, (req: Request) => Promise<Response>)`，插件**不依赖 Nest**、不写 controller。内核在 Fastify 的独立封装作用域里收下 `/plugins/*`，再转成 Web `Request` 交给你：

- **路径语法与 Fastify 相同**（find-my-way）：`path` 相对插件前缀，如 `route("GET", "/items/:id", …)` 匹配 `/plugins/<name>/items/42`；也支持通配 `*`。匹配只看路径，不含查询串。
- **handler 只收到 Web `Request`，拿不到解析好的路径参数**：自己从 `new URL(req.url).pathname` 里取（查询串用 `new URL(req.url).searchParams`）。
- **body 是原始字节**：作用域内不做 JSON / 表单解析，任何 content-type 都原样转交，`await req.text()` / `req.json()` / `req.arrayBuffer()` 自己解析（webhook 验签可直接用原始字节）。GET / HEAD 不带 body。
- **请求体上限 1 MiB**（Fastify 默认 bodyLimit），超出直接 413 `payload_too_large`（内核错误信封），到不了 handler。作用域内 Fastify 自身的其他 4xx 同样按内核通用错误码表映射（如 415 `unsupported_media_type`、400 `validation_failed`）。
- **HEAD 按 GET 处理**：没有专门的 HEAD 路由时，HEAD 请求交给同路径的 GET handler（`req.method` 仍是 `"HEAD"`），响应只回状态与头、不带 body。
- 请求无法转成 Web `Request`（如畸形 `Host` 头）→ 400 `validation_failed`，到不了 handler。
- 尾斜杠敏感：`/count` 与 `/count/` 是两条路由。
- 未匹配 → 404 `not_found`；handler 抛错 → 500 `internal`（错误记日志，日志里的路径经脱敏：以 `cap_` 开头的路径段换成 `:redacted`；不回显给客户端）。
- **插件路由不经内核鉴权**：没有 AuthGuard、不检查 CSRF 头、拿不到调用者身份（尚未提供；清单的 `public` 目前只是声明，Ruling A2）。对外暴露的 webhook 必须自行验签。
- **内核会话 Cookie 被剥掉**：转交前从 `Cookie` 头删去 `cap_at` / `cap_rt`（其余 Cookie 原样保留；只剩这两个时不带 `Cookie` 头），插件拿不到用户的内核会话。
- 响应的 status、头（含多条 `set-cookie`）原样回给客户端，body 支持流式。
- `req.signal` 只在响应写完之前客户端断开时中止（正常写完不会中止）：长连接（SSE）的 handler 用它退订、收尾。
- **停机时内核中止所有进行中的插件请求**（`req.signal` 一齐 abort，此后到达的请求一开始就是中止的）：handler 要么很快结束，要么能容忍中止（收到 abort 就结束流、放弃未完成的工作；需要做完的事放进队列）。不响应 signal 的长连接会占用 http 停机预算，到时被强制断开。
- 嵌入应用的路由放在 `/ui/` 下，网页经同源代理 `/plugin-ui/<插件>/...` 访问，代理只转发嵌入令牌、改写响应头与缓存，见 `skills/writing-plugin-ui`。

### 界面（视图与嵌入应用）

插件往网页加界面（对话页右侧标签、顶栏「扩展」里的组织页面）有两档：渲染 schema 视图（`ctx.ui.view`，参考 `plugins/todo`）与沙箱 iframe 里的嵌入应用（插件 `/ui/` 下的路由 + `ctx.ui.verifyEmbedToken`，参考 `plugins/example-board`）。清单、批准规则、积木与上限、嵌入令牌、`/plugin-ui` 代理、消息桥与测试写法都在 `skills/writing-plugin-ui`。

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

要点：`h.request` 的返回值带 `replica`（0 / 1，取自响应头 `x-capybara-replica`，harness 给每个副本设了 `http.replicaId`）；按 `h.replicas[i].port` 直接 `fetch` 指定副本时用 `replicaOf(res)` 确认落点（如 SSE 长连接）。`h.kill(i)` 对副本 i 发 SIGKILL 模拟硬崩溃（之后经 `h.request` 发往它的请求抛错），用来测「另一个副本接手」。`config` 选项可把额外的内核配置深合并进两个副本（如 `config: { auth: { cookieSecure: false } }`，经 IPC 传递）；每个 harness 自带一个 Redis 容器，用完 `stop()`；传入 `pgUrl`（管理员连接串）可让多个 harness 复用同一个 PG 容器；队列任务异步执行，断言时轮询等到期望值，不要只 `sleep` 固定时长；测试文件放在插件根的 `test/` 目录（`pnpm test` 会收集）。

## 插件包（npm-pack tgz）

插件在核心镜像之外，按插件包安装（C11）。`pnpm pack-plugin plugins/<name> [--out <dir>]` 打一个，`pnpm pack-plugins` 打全部（默认输出 `artifacts/plugins/`，CI 作为构建产物上传）；`pnpm check` 里的「插件打包」（`check:plugin-pack`）要求每个官方插件都能打成并通过内核校验。写插件时注意：

- esbuild 把 `src/index.ts` 打成单文件 ESM `dist/index.mjs`，三方依赖全部打进去；只有 `@capybara-hq/plugin-sdk` 与 `zod`（含子路径）由宿主提供，Node 内置模块一律改写成 `node:*`。打不进去的依赖（没装、原生模块 `*.node`）就是打包失败。
- **动态 `import()` 只许字面量**；`import(变量)` 打包和安装都会拒绝。
- 清单 `version` 必须等于插件 `package.json` 的 `version`；声明了 `migrations` 时它必须解析到插件根的 `migrations/`（如 `"../migrations"`），包里记为 `capybara.migrations: "migrations"`；插件根有 `ui/` 时原样带上。
- `package.json` 的 `capybara.manifest` 是 `staticManifestOf(清单)` 的结果：审阅只看它与迁移 SQL，不执行插件代码；加载时再与真实模块核对，不一致即 `manifest_mismatch`。所以清单（权限、配置字段的 secret / hot）不能依赖运行时环境。
- 生成的包不带安装脚本、`dependencies`、`node_modules/`；安装时内核按 `readPluginPackage` 的规则拒绝这些（以及路径越界、链接、超大包）。

**安装、启用、停用、升级、卸载（不重启，C16 / C18）**：包先导入包存储（后台上传 / npm，或 `capybara plugins install <file.tgz | npm:<名>[@<版本>]>`，CLI 导入的包一律存 PG），再由安装记录指向它（`POST /api/v1/admin/plugins/:name/install {sha256}`；新装为停用），`…/enable`、`…/disable`、`DELETE …/:name`（须先停用）改期望状态；CLI 对应 `capybara plugins list | enable | disable | uninstall <name>`。后台与 CLI **只写 PG 期望状态**并发布 `kernel.plugins.changed`，各副本 reconcile 收敛（维护任务 `plugins-reconcile` 每 `pluginHost.reconcileIntervalSeconds` 秒发布 `kernel.plugins.reconcile` 兜底，丢了消息也能收敛）。写插件时要知道的：

- 换版本时**先加载新版本、再撤销旧版本**（旧实例在后台排空在途调用）；新版本在某个副本上加载失败（`sync_failed` / `sha_mismatch` / `import_failed` / `manifest_mismatch` / `setup_failed` / `migration_failed`），那个副本继续跑旧版本、状态记 `failed`，之后每个周期重试。新版本权限超出快照时待批准，旧版本照常。
- **迁移只做扩展**（加表、加列、加索引；删改走两步，见 `skills/writing-migrations`）：新旧版本会在不同副本上同时跑。上传 / 导入包时，迁移里的破坏性语句（删表 / 删列、TRUNCATE、DELETE、RENAME、改列类型，`destructive_migration`）与内容不做静态检查的 `DO` 块（`dynamic_sql`）在审阅结果的 `warnings` 里逐条列为敏感警告（不拒绝），部署方会看到；别用 `DO` 块。迁移由第一个拿到咨询锁的副本执行一次（`ensureMigrated`），完成前其他副本不切换（`pending_migration`）。迁移目录只认包里审阅过的 `capybara.migrations`。
- **降级**只能回到「迁移文件都已执行过（文件名与内容一致）」的版本，否则 409 `plugin.downgrade_unsupported`。
- 停用 / 卸载不删数据：插件 schema、密钥、组织配置、权限快照都保留，重新安装后接着用。部署上停用时组织里的启用开关不变，组织页显示「不可用」。
- **插件名归 npm 包所有**：插件名归第一次安装它的 npm 包（`package.json` 的 `name`，记在 `plugin_name_owners`，只上传没安装的包不占名字），同名插件只能来自这个包。卸载之后也一样（卸载不删归属）：数据、密钥、批准快照与组织启用都还在，另一个 npm 包用同一个插件名安装会被拒绝（409 `plugin.name_conflict`，提示该名字之前由哪个包使用），防止换个发布者接手这些数据；原来的包可以重新安装。所以**改 npm 包名等于换一个插件**，插件名也要换。
- 内核消费的提供方调用（`connector@1` 的 `open` 到会话 `close`、`sandbox@1`、`model-provider@*` 的每次调用与流）和插件工具一样计入实例的在途计数：停用 / 升级时先排空，到时限中止（参数里的 `AbortSignal` 被中止）。提供方实现要理会传入的 signal。

## 新插件清单

1. 复制 `plugins/example-counter`，改包名 `@capybara-hq/plugin-<name>`、`name`、PG 表。
2. 在根 `tsconfig.json` 的 `references` 加一项。
3. 迁移按 `skills/writing-migrations` 写。
4. `pnpm lint && pnpm typecheck && pnpm check && pnpm test`。
5. 影响发布的改动加 changeset（`pnpm changeset`）。
