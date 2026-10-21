# 扩展模型设计

- 日期：2026-10-18
- 状态：已确认；结论已于 2026-10-19 并入总设计 §2.1–§2.5、§4.5、§7.3、§8.1、§8.2，本文保留为决策记录与细节
- 关系：补充并修订《Capybara 整体架构设计》（`2026-10-17-capybara-architecture-design.md`）第 2 章「内核与插件契约」；
  与 M3（工具与连接器）并行编写，**不依赖 M3 的实现**，M3 合并后再把结论并入总设计（见第 10 节）。

## 0. 背景与目标

总设计已经定下「内核只做配置 / 数据库 / 插件宿主 / HTTP，能力全部以插件形式提供」，插件清单也已有 `provides` / `requires`。
但目前只走通了一半：插件能**提供**能力，内核能**使用**能力；插件之间互相使用、插件使用平台的治理类能力（模型、存储），都还没有规范。
本文把「插件」定义为可扩展平台任意能力的单位，并补齐四件事：

1. **能力的取用**：插件既能提供能力，也能使用平台或其他插件提供的能力；依赖的是能力，不是某个插件。
2. **模型能力层**：对话、向量、多模态等按模态分契约；平台功能与插件按「用途」向内核要模型，不各自接入模型。
3. **对象存储与配置**：对象存储做成插件能力；插件配置一律有 schema、按插件名分命名空间，密钥走密钥存储。
4. **权限清单**：参照安卓 / iOS，插件声明它要用的一切，管理员安装时可见；**未声明即禁止使用**。

### 0.1 非目标

- 记忆、知识库仍不在 MVP（总设计 0.2 不变）；向量、重排契约只预留形状，不排期。
- 不给外部应用开放模型调用入口：模型能力层只服务内核与本部署的插件。
- 不做插件的进程级隔离（总设计 2.5 不变）。权限清单是**平台接口层的治理**，不是安全沙箱（见 7.5）。
- 生成类模型（文生图、文生视频、TTS）不进模型能力层，做成工具（见 4.4）。实时双向语音不在范围内。

## 1. 术语

| 术语 | 含义 |
|---|---|
| **插件** | 打包与安装的单位：一个 npm 包 + 插件清单，由企业管理员安装。一个插件可提供多种能力，也可使用多种能力 |
| **能力** | 带主版本号的扩展点契约，类型在 `@capybara-hq/plugin-sdk`，形如 `channel@1`、`model-provider@2` |
| **平台能力** | 内核经 `ctx` 直接提供给插件的接口（`ctx.db`、`ctx.kv`、`ctx.models`、`ctx.storage`……） |
| **提供方 / 消费方** | 实现某能力的插件 / 使用某能力的内核模块或插件 |
| **扩展点调用** | 内核在某个时机调用插件提供的实现（工具执行、hook、渠道入站……），并带上本次调用的上下文 |

名字保持「插件」，不改叫「扩展」：平台里已有「应用」「技能」「连接器」，再加「扩展」容易混淆。

## 2. 能力的提供与取用

### 2.1 依赖能力，不依赖插件

插件 A 需要的是「某种能力」，不是「插件 B」：

```ts
definePlugin({
  name: "approval-cards",
  requires: ["channel@1"],            // 缺了就不能加载
  optional: ["directory@1"],          // 缺了也能加载，取用时得到空列表
  ...
});
```

- `requires` 已实现（加载时校验存在、无环、按依赖拓扑排序）；新增 `optional`，语义同上但缺失不阻止加载。
- 依赖按**主版本**匹配；SDK 同时支持当前主版本与上一主版本（总设计 2.5）。
- 换实现（B 换成 C）对 A 透明；多个提供者时选谁，由消费方按名字选或由组织配置决定（2.3），不由插件代码写死。

### 2.2 两类能力：直通与经内核中转

| 类 | 例子 | 消费方怎么用 | 原因 |
|---|---|---|---|
| **直通** | `directory@1`、`channel@1`、`identity-source@1` | `ctx.capabilities.get` / `list` 直接拿到实现 | 无需平台统一治理 |
| **中转（治理类）** | `model-provider`、`embedding-provider`、`object-store`、`secret-store`、`connector`、`sandbox` | 只能经平台能力（`ctx.models`、`ctx.storage`……）使用，**拿不到原始实现** | 凭据、计量、配额、审计、租户隔离必须统一在内核做 |

能力登记表（`CAPABILITY_CARDINALITY`）扩成 `{ cardinality, brokered }`；`ctx.capabilities.get` 对 `brokered` 能力直接抛错。

> **M4 实现说明**：登记表为 `CAPABILITIES`（`packages/plugin-sdk/src/capability.ts`），每项 `{ cardinality, brokered, orgScoped }`；`channel`、`directory` 为 `orgScoped`，`identity-source` 不是（登录是部署级，经 `auth.loginSources` 启用，Ruling P1）。`get` / `list` 另有带 `{ orgId }` 的重载：返回 Promise、按该组织的启用状态过滤（每次查库，不缓存；Ruling A1），不带 `orgId` 时同步、不按组织过滤。取 brokered 能力抛普通 `Error`（声明也解决不了，不记审计；Ruling A3）。

```ts
// ctx 新增（只能取清单 requires / optional 里声明过的能力）
capabilities: {
  /** 单选能力不传 provider；多选能力必须传。 */
  get<T>(ref: CapabilityRef, provider?: string): T;
  list<T>(ref: CapabilityRef): { plugin: string; impl: T }[];
};
```

- 依赖按拓扑序加载，`setup` 时被依赖方已就绪；实现对象本身是无状态的工厂 / 函数，可在 `setup` 中取用并闭包持有，
  不违反「无进程内可变状态」。
- 内核已有的 `PluginHost.get` / `list` 是这组接口的实现基础。

### 2.3 组织启用与不可用

- 插件**安装在部署级、启用在组织级**（总设计 2.2）。A 依赖的能力在某组织没有任何已启用的提供者时，**在该组织启用 A 会被拒绝**，并提示缺哪个能力。
- 运行中被依赖方在该组织被停用：取用时抛 `CapabilityUnavailableError`（`optional` 能力在 `list` 中消失），由 A 决定失败还是降级。
  停用被依赖方时界面提示「以下插件依赖它」。
  （M4 实现：只有停用会让某个已启用的依赖方**再无**该能力的已启用提供方时才拒绝，`plugin.has_dependents`，可强制，Ruling A5。）
- 部署级的能力（如模型供应商）不受组织启用开关影响，按 4.2 的用途配置决定组织能用哪些模型。

## 3. 调用上下文：跟着扩展点走

- `setup(ctx)` 拿到的是**部署级**上下文：看不到任何组织、账号、会话。
- 内核调用插件实现时，在调用参数里带上本次的上下文，**内容由扩展点决定**：

| 扩展点 | 上下文 |
|---|---|
| 工具执行（M3 `ToolCallContext`） | 组织、账号、agent、会话、调用 id、中止信号 |
| `agent.preStep`、`model.request/response` 等 hook | 组织、账号、agent、会话，以及该时机的数据（消息、模型请求） |
| 渠道入站 | 组织、渠道、外部身份 |
| 登录（`identity-source`） | 认证请求与外部身份，不含任何会话 |
| 队列任务 | 插件自己入队时写进 job 数据的内容（通常带 orgId）；内核校验插件在该组织已启用 |

- M3 的 `ToolCallContext` 就是这条原则的第一个实现，其他扩展点照此设计。
- **能看到会话内容的扩展点**（工具、`agent.preStep`、`model.*`、`tool.*` hook、渠道入站）在权限清单里单独声明并高亮（7.2）。
- 插件需要跨调用保存的会话相关数据写自己的 `ctx.db`，这属于插件数据，在清单的数据项中展示；多副本纪律已禁止放进程内存。

> **M4 实现说明**：渠道插件实际拿到的是渠道连接的 `connectionId` 与连接配置（`send` 另有目标、消息与组织语言 `locale`），组织与发言人账号由内核按连接与身份解析，插件看不到；通讯录只拿到该组织的组织级配置。提供 `channel@1` 不是单独的权限项，而是在「提供的能力」一组里展示：该组含 `channel@1`（收到组织在 IM 里的对话，Ruling A33）、`directory@1`（能把人加进组织）或 `identity-source@1`（决定谁能登录成哪个账号）时标为敏感；其余敏感分组为密钥、公开路由、工具、hook（Ruling A5）。渠道插件声明的 `features.cards` / `threads` 为 false 时，内核把卡片退回为文本、目标去掉 `threadId` 后再交给插件（Ruling A33）。

## 4. 模型能力层

### 4.1 按模态分契约

| 能力 | 状态 | 说明 |
|---|---|---|
| `model-provider@2` | 已有 | 对话：流式、工具调用、思考、缓存。agent 主循环使用 |
| 媒体输入（图片 / 音频 / 视频作为输入） | M5 设计 | 在对话契约中加媒体块，字节存对象存储、事件日志只记引用；模型按媒体类型声明支持，内核不给不支持的模型发媒体。倾向在 `@2` 内追加并由声明把关，是否需要 `@3` 在 M5 定 |
| `embedding-provider@1` | 预留 | `listModels()`（维度、最大输入、批量上限）+ `embed(inputs, { model, dimensions?, inputType? })` → 向量与用量 |
| `rerank-provider@1` | 预留 | 形状与向量类似，随第一个消费方设计 |

- 一个供应商插件可同时提供多种模型能力（如百炼插件提供 `model-provider@2` 与 `embedding-provider@1`），密钥配一次。
- 每种能力都有一致性套件，规则同 `skills/writing-model-providers`（原生协议、不在插件内重试、错误映射）。

### 4.2 用途：按用途要模型，不写死模型 id

- agent 主循环用 agent 版本里选定的模型（已有，不变）。
- 其他平台功能与插件按**用途**要模型。用途由内核或插件在清单里声明：

```ts
models: [
  { purpose: "summarize", kind: "chat", requires: { tools: false }, label: { zh: "会话摘要", en: "Summaries" } },
]
// 插件声明的用途键为 "<插件名>.<名称>"，与参数键规则一致；内核自己的用途无前缀（如 "compaction"）。
```

- 组织管理员在后台把每个用途映射到一个具体模型（可选：企业管理员给默认映射）；未映射的用途调用时报 `model.unconfigured`。
- 向量用途特别注意：换模型会让已存向量作废，所以 `embed` 的结果带 `{ provider, model, dimensions }`，消费方必须随向量一起存，
  映射变更时界面提示「已有数据需要重建」。

### 4.3 `ctx.models`

```ts
models: {
  chat(req: { purpose: string; system?; messages; tools?; params? }, call: { orgId: string; signal: AbortSignal }):
    AsyncIterable<ModelStreamEvent>;
  embed(req: { purpose: string; inputs: string[]; inputType?: "query" | "document" }, call: { orgId: string; signal: AbortSignal }):
    Promise<{ provider: string; model: string; dimensions: number; vectors: number[][]; usage }>;
};
```

内核在中间统一做：按用途解析模型 → 校验插件已声明该用途且在该组织启用 → 配额 → 调用（复用现有降级梯子）→
产生带（组织、插件、用途）归属的用量事件（`usage.report`）→ 审计。

- 插件在会话内部调用模型（例如工具内部再问一次模型）不写入会话事件日志——那不是主循环模型看到的内容；
  用量记录带上 `conversationId` 与 `callId` 以便追溯。「模型看到的一切都进日志」仍只约束主循环。
- `ctx.models` 没有 MVP 内的消费方，接口形状在此定下，**实现随第一个消费方排期**。

### 4.4 生成类做工具

文生图、文生视频、TTS 是「提交任务 → 轮询结果」，产物大，用法是「模型决定调用」：做成插件经 `ctx.tools` 注册的工具，
轮询走 `ctx.queue`，产物走对象存储或 M3 的输出存档（artifacts）。不新增模型能力。

## 5. 对象存储

- 新能力 `object-store@1`：**单选、中转**（一个部署一套存储）。
- 契约（插件实现）：`put(key, body, { contentType, size })`、`get(key)`（流）、`head`、`delete`、`list(prefix, cursor)`、
  `presignGet(key, ttl)`、`presignPut(key, { contentType, maxSize, ttl })`。大文件上传下载由浏览器经预签名 URL 直连存储，不经内核中转。
- 默认实现 `plugins/object-store-s3`：官方 `@aws-sdk/client-s3`，支持 `forcePathStyle`。一份覆盖 MinIO、Ceph、SeaweedFS，
  以及提供 S3 兼容接口的阿里 OSS、火山 TOS；需要原生接口再单独写插件。
- 平台能力 `ctx.storage`：与 `object-store@1` 同形，但**键自动加前缀** `plugins/<插件名>/<orgId>/…`（内核自己用 `kernel/…`），
  插件看不到也写不了别人的对象，类似 `ctx.db` 的独立 schema。所有方法都要求 `orgId`。
- 组织数据导出与删除（总设计 8.8）按前缀覆盖对象存储。
- 内核自己也是消费方：附件、沙箱文件导入导出（M5）。M3 的输出存档已定为放在 PG，不受影响。
- 没装提供方时：声明了 `storage` 的插件不能加载，依赖对象存储的内核功能不可用并在后台提示。试用编排自带 MinIO。

## 6. 配置与密钥

三件事分开：

| | 存什么 | 存在哪 | 谁改 |
|---|---|---|---|
| **启动配置**（`config-source@1`） | 数据库、Redis、主密钥、要加载的插件 | 文件 / Nacos / 环境变量（连上数据库之前就要拿到） | 部署者 |
| **插件配置**（部署级、组织级） | 插件的业务配置，如 client id、区域、开关 | PG，按插件名分命名空间 | 企业管理员 / 组织管理员（后台界面） |
| **密钥**（`secret-store@1`） | client secret、token | 默认 PG 信封加密；可换 Vault / 云 KMS 插件 | 同上，只写不回显 |

- **插件配置一律有 schema**（清单 `config.deployment` / `config.org`，zod）：写入时校验、界面按 schema 生成表单、
  `secret()` 字段自动交给密钥存储、清单里可展示。不提供无 schema 的自由键值配置；插件运行时状态用 `ctx.kv`（必须带 TTL），业务数据用 `ctx.db`。
- 组织级插件配置已在 PG（M1）。**改动点：部署级插件配置也存进 PG**，企业管理员在后台修改，平台负责校验、加密、审计与跨副本生效：
  - 启动配置里的 `pluginConfig.<插件名>` 保留，作为**部署文件管理的值**：出现在文件 / Nacos / 环境变量里的字段在界面上只读并标注来源，
    不出现的字段由界面管理。这样既能 GitOps，也能在界面上改，同一个字段不会有两个来源。
  - 跨副本生效：写入后经 `ctx.bus` 广播；插件在 schema 字段 meta 上标 `hot: true`（与内核配置同一写法）的字段各副本即时生效
    （插件通过 `ctx.config` 读到新值，接口细节在实施计划定），其余字段界面提示「重启后生效」。
- 这样 Nacos 只承载启动配置，插件的复杂业务配置不再堆进 Nacos。

## 7. 权限清单

### 7.1 原则

插件**声明它要用的一切**，企业管理员安装时看到并确认，**未声明即禁止**：内核按清单为每个插件构造 `ctx`，没声明的平台能力不存在
（访问时抛 `PluginPermissionError`，消息写明要在清单里声明什么）。

### 7.2 声明什么、怎么展示

能从已有字段推导的不重复声明；新增 `permissions` 字段只写推导不出来的部分。

| 项 | 来源 | 级别 | 安装时展示 |
|---|---|---|---|
| 提供的能力 | `provides` | — | 「本插件提供：模型供应商、渠道……」 |
| 使用的能力 | `requires` / `optional` | 普通 | 「本插件使用：通讯录……」 |
| 配置项 | `config` schema | 普通 | 部署级、组织级配置字段，密钥字段标出 |
| 数据表 | `migrations`（解析迁移 SQL） | 普通 | schema 名、表名，可展开看 SQL |
| 基础平台能力 | 自动授予 | 基础 | `kv`、`lock`、`bus`、`queue`、`log`、自己的 `db`：列出但无需单独声明 |
| 模型 | `permissions.models`（用途列表，4.2） | 普通 | 「会调用模型：会话摘要（对话）」 |
| 对象存储 | `permissions.storage` | 普通 | 「会读写对象存储」 |
| 密钥 | `permissions.secrets` | **敏感** | 「会保存密钥」 |
| HTTP 路由 | `permissions.http`（路由列表，含是否公开） | 公开路由**敏感** | 路由列表（M4：`public` 只是声明，插件路由仍不经内核鉴权，见下方说明） |
| 工具 | `permissions.tools`（工具名列表） | **敏感** | 工具名与描述（工具能看到会话参数） |
| Hook | `permissions.hooks`（挂载点列表） | 能看到会话内容的**敏感** | 挂载点与说明 |
| 外部网络 | `permissions.network`（域名列表） | 仅展示（MVP 不拦截，见第 11 节） | 「会访问：open.feishu.cn……」，标注「声明，平台不拦截」 |

敏感项在安装确认页单独高亮；组织管理员启用插件时也能看到同一张清单。

> **M4 实现说明**：`permissions.http[].public` 目前只用于展示与快照（Ruling A2）：插件路由不论是否声明 `public` 都和 M0 起一样不经内核鉴权、由插件自行验签；非公开插件路由改由内核鉴权是以后的决定（届时是一次行为变更）。`hooks` 只校验挂载点名（`ctx.hooks` 在 M6），`models` / `storage` 为预留项，用了 `check:plugin-permissions` 报 `perm-reserved`。

### 7.3 批准与升级

- 内核在 PG 记录每个插件**已批准的权限快照**。插件首次出现、或升级后清单比快照多出任何一项，该插件**不加载**，
  后台显示「待批准」，企业管理员确认后生效；权限变少或不变的升级直接生效。
- 后台界面之前（M6 以前）用 CLI：`capybara plugins review` / `capybara plugins approve <name>`。
- 开发与试用可在启动配置里显式开启 `pluginPermissions.autoApprove: true`（`plugins` 仍是要加载的插件名数组，Ruling A4），启动时自动批准并打 warn 日志；生产默认关闭。
- **M4 实现说明**：快照也约束 `capybara migrate`（未批准的插件不跑迁移、不建表；`plugins review` 会先跑内核迁移）；自动批准写快照（来源 auto）但不写审计；比快照版本旧的插件（滚动升级中重启的旧副本、回滚）权限不超出快照就照常加载，快照不缩减；「多出一项」按条目比较，把公开路由改成非公开、密钥字段改成普通字段也算新条目；数据表只解析 `CREATE TABLE`（`ALTER … RENAME`、视图不进快照）。「后台显示待批准」随 M6 管理后台提供，M4 只有 CLI 与启动日志。

### 7.4 自动检查

- `definePlugin` 校验 `permissions` 格式（用途键前缀、路由格式、挂载点名）。
- 新增检查 `check:plugin-permissions`：静态扫描插件源码中的 `ctx.<x>` 使用、`ctx.tools.register` 的工具名、`ctx.http.route` 的路由，
  与清单比对，用了未声明的即失败。按惯例带「违规 fixture 使其失败」的测试。
- 运行时兜底：未声明的访问抛 `PluginPermissionError`，并记审计。

### 7.5 边界：这不是沙箱

插件是进程内运行的受信代码，可以自己 `import pg` 直连数据库、直接发网络请求、读环境变量，进程内拦不住。安卓权限有效靠的是进程隔离，我们没有这一层。
所以权限清单的作用是：

- **真正拦住平台资源**：模型、凭据、对象存储、会话内容都握在内核手里，没声明就拿不到；
- **透明与审计**：管理员知道装进来的插件要什么、升级多要了什么；
- **约束诚实的插件作者**：自动检查让「忘了声明」在 CI 里就失败。

对恶意代码的防线仍是总设计 2.5 / 7.4：只有企业管理员能安装、npm provenance、公共市场的自动检查与审核；不受信的扩展做成外部应用。
安装页对「外部网络」等平台拦不住的项照实标注「声明」，不制造虚假的安全感。

## 8. 对现有代码与文档的影响

| 位置 | 改动 |
|---|---|
| `packages/plugin-sdk/src/define-plugin.ts` | 清单加 `optional`、`permissions`；校验 |
| `packages/plugin-sdk/src/capability.ts` | 登记表加 `brokered`；新能力 `object-store`（单选、中转）、预留 `embedding-provider` / `rerank-provider` |
| `packages/plugin-sdk/src/ctx.ts` | 加 `capabilities`、`storage`；预留 `models`；平台能力按清单可缺省 |
| `packages/kernel/src/ctx/create-ctx.ts`、`plugins/host.ts` | 按清单构造 `ctx`；权限快照与「待批准」；组织启用时校验依赖 |
| `packages/kernel/src/plugins/org-config.ts` | 部署级插件配置入 PG、来源标注、广播生效 |
| `skills/writing-plugins` | 权限清单、能力取用、调用上下文 |
| 总设计 §2.1–§2.3、§4.5、§7.3、§8.1、§8.2 | 并入本文结论（见第 10 节） |

## 9. 分期

| 内容 | 时机 | 理由 |
|---|---|---|
| 方舟方言（`openai-compatible` 加 `ark`） | 随时，M2 后续 | 小改动，与本文独立 |
| 清单格式（`optional`、`permissions`）+ 按清单构造 `ctx` + `ctx.capabilities` + `check:plugin-permissions` + 权限快照与 CLI 批准 | **M4 第一组任务** | M4 一次进来 Slack、飞书等多能力插件，清单格式要在它们之前定；渠道、身份、通讯录开始互相取用 |
| `object-store@1` + `object-store-s3` + `ctx.storage` | **M5 开头** | 第一个消费方是附件与沙箱文件 |
| 媒体输入契约 | **M5** | 依赖对象存储与附件 |
| 部署级插件配置入 PG、安装确认页、用途 → 模型配置页 | **M6**（管理后台） | 界面在 M6；M6 的「SDK 公开 API 快照检查」之前清单格式必须稳定 |
| `ctx.models`、向量、重排 | MVP 之后，随第一个消费方 | MVP 内没有消费方（记忆、知识库不做） |

M3 不需要改动：`ctx.tools` 与 `ToolCallContext` 已符合第 3 节；M4 引入权限清单时把 `tools` 纳入声明即可。

## 10. 与总设计的合并

M3 分支正在修改总设计 §2.1、§2.3、§5.4。为避免冲突，本文先独立成文；M3 合并后另起一次文档提交，把第 2、4、5、6、7 节的结论并入总设计对应章节，
本文保留为决策记录。

## 11. 已定决策（2026-10-19 与用户确认）

1. 可选依赖用**单独的 `optional` 字段**，不在 `requires` 条目里加 `optional: true`：安装确认页的「必需 / 可选」两栏直接对应两个字段。
2. 部署级插件配置的热更新**沿用内核配置的 `hot` 标记**：插件在 schema 字段的 meta 上标 `hot: true`，标了的字段改后即时生效，
   插件只需处理自己标了 `hot` 的字段；没标的字段界面提示「重启后生效」。
3. 权限**由企业管理员批准**（安装与升级时）；组织管理员启用插件时看到同一张清单，但不再单独批准。
4. 外部网络域名 **MVP 只展示**，安装页标注「声明，平台不拦截」；以后部署启用出站代理时再按清单放行，作为后续增强。
