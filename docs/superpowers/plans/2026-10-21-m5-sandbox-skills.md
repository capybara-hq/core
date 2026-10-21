# M5 对象存储、沙箱与技能 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 agent 加三样东西：一是对象存储与附件（图片、PDF 可以作为模型输入），二是每个对话一个隔离沙箱（Docker / E2B），可以在里面跑命令、读写文件、交付产物，三是兼容 Anthropic Agent Skills 格式的技能，含 agent 自写技能与 R4 审批。

**Architecture:**
- 对象存储与沙箱都是**中转能力**：插件实现 `object-store@1` / `sandbox@1`，内核代为调用，并统一负责租户前缀、配额、审计与多副本协调。
- 附件与产物的字节放在对象存储，事件日志只记引用。媒体块在 `model-provider@2` 内追加，由模型声明把关。
- 沙箱按对话懒创建：空闲时休眠，长期不用才销毁；沙箱工具是内核内置工具。
- 技能的元数据放 PG，文件放对象存储；用到技能时，按需复制进沙箱。

**Tech Stack:** TypeScript、NestJS + Fastify、Kysely + 纯 SQL 迁移、BullMQ、Redis、`@aws-sdk/client-s3`、Docker Engine API（经 socket 代理）、E2B SDK、Next + `@capybara-hq/design`、Vitest + Testcontainers（PG / Valkey / MinIO）。

**Spec:**
- `docs/superpowers/specs/2026-10-17-capybara-architecture-design.md`：§3.6（R1–R6）、§5.6（技能）、§8.3（沙箱）、§8.8（数据删除）。
- `docs/superpowers/specs/2026-10-18-extension-model-design.md`：§2（中转能力）、§4.1（媒体输入）、§5（对象存储）、§7（权限清单）。
- 用户决策 D1–D12 见下文，也记在记忆 `capybara-m5-decisions` 里。

---

## 决策摘要（2026-10-21 用户确认）

- **D1** 分三段。
  - 第一段：对象存储，附件与媒体输入。
  - 第二段：沙箱、沙箱工具与产物。
  - 第三段：技能（格式、`skill_load`、agent 自写技能）。
- **D2** 沙箱实现两种。
  - **Docker**：runc 和 runsc（gVisor）都支持，经 socket 代理，内核不挂 docker.sock。
  - **E2B**：官方 SDK，云端与自托管都支持。
  - K8s 以后再做。
- **D3** 沙箱做成插件。
  - 能力 `sandbox@1`（单选、中转）。
  - 实现插件为 `plugins/sandbox-docker` 和 `plugins/sandbox-e2b`。
- **D4** 每个对话一个沙箱，第一次用到才创建。
  - 空闲 10 分钟休眠，休眠时只保留文件。
  - 7 天不活跃就销毁。
  - 磁盘上限 5G，可配置。
  - 「agent + 用户」持久工作区以后再加，不需要改接口。
- **D5** 沙箱工具：`bash`、`read`、`write`、`edit`、`glob`、`grep`。默认策略是 allow（因为隔离），组织可以改为 ask。
- **D6** 出站网络默认白名单，预置常用包源；组织可以增删，也可以设为 none。
- **D7** 限额：1 CPU、2G 内存、单条命令最长 2 小时、空闲 10 分钟休眠。
- **D8** 文件进出沙箱：
  - 进：附件会出现在沙箱里。
  - 出：agent 交付的文件进对象存储，在右侧「产物」标签里预览、下载。
- **D9** 媒体输入先做图片和 PDF。
  - 模型自己声明支持哪些媒体；不支持时，内核给模型的是文字占位。
  - 字节存对象存储，日志只记引用。
- **D10** `plugins/object-store-s3`：兼容 MinIO 等 S3 存储；开发用 compose 加 MinIO；插件经 `ctx.storage` 使用，自动加前缀。
- **D11** 技能分两种：组织技能库，以及 agent 自己的技能。格式兼容 Anthropic Agent Skills；元数据在 PG，文件在对象存储；市场留到 M6。
- **D12** R4：私有 agent 写技能直接生效；共享 agent 写技能进收件箱，负责人批准后对他人生效。

## 计划层面的取舍（设计者的决定，执行中如被推翻，记入台账）

- **C1 媒体块追加在 `model-provider@2` 内，不升 `@3`。**
  - 新块类型 `image` / `document`。
  - 发出前由 `ModelInfo.capabilities.vision` 与新增的 `capabilities.documents` 把关；模型不支持时，换成文字占位 `[image: <name>]` / `[document: <name>]`。
  - 理由：已有插件不认识的块会被跳过，不会报错；把关在内核做，插件不用感知。
- **C2 附件上传走预签名 PUT 直传存储。**
  - 内核先登记一条 `attachments` 记录（状态 `pending`），给出预签名 URL。
  - 浏览器上传完成后调 `finalize`：内核 `head` 核对大小与类型，然后标记为 `ready`。
  - 发消息时只引用 `ready` 的附件 id。
- **C3 「产物」以新事件 `artifact_created` 进对话日志**（id、名称、类型、大小、对象键），网页从日志重建产物列表。这样产物和模型调用一样，能按日志完整重建。
- **C4 出站白名单由 Docker 插件内置的 HTTP(S) 代理容器实现**，按域名放行（CONNECT 与 Host 头）。E2B 用它自己的网络策略：白名单映射到 E2B 的出站控制，做不到时在插件文档里写明并拒绝 `allowlist`。（执行 T10 前先查 E2B 文档；设计者的决定，执行时核实。）
- **C5 沙箱状态放 PG 表 `sandboxes`，创建、恢复用 Redis 锁**（`capk:sandbox:<conversationId>`）。空闲休眠与过期销毁由维护队列定期扫描完成，不用进程内定时器。
- **C6 技能变更审批用新表 `skill_change_requests` 和收件箱的新来源**，不放宽 `approvals` 的 run 绑定。收件箱接口改为按类型汇总。
- **C7 技能文件进沙箱的路径为 `/skills/<skill-name>/`**（只读复制）。附件放 `/workspace/attachments/`，工作目录是 `/workspace`。

## Global Constraints

- 插件只依赖 `@capybara-hq/plugin-sdk` 和第三方包。SDK 只放类型与纯函数。内核不得 import 插件。
- **多副本纪律**：
  - 写入方与读取方可能不在同一进程的状态，一律放 PG 或 Redis。`ctx` 不提供定时器。
  - BullMQ 队列名与 job id 不得含 `:`。
  - `ctx.kv` 写入必须带 TTL。
- **迁移**：纯 SQL，命名 `NNNN_<snake>.sql`，从 `0021` 起。建表、删表都带 `IF NOT EXISTS` / `IF EXISTS`。内核的 schema 是 `capybara`，插件的是 `plugin_<name>`。
- **配置**：
  - 前缀 `CAPYBARA_`，嵌套用双下划线。
  - 新键写进 `packages/kernel/src/config/schema.ts`，并重新生成 `docs/config.md`。
  - 密钥字段要标 `secret`。
- **文案**：给模型看的文本（工具描述、错误、占位）一律英文。界面文案走 i18n，中英两套。
- **界面**：`apps/web` 只用 design 的模板与组件，不写样式，也不直接用 iframe。新组件按 `skills/writing-web-ui` 四步走；截图基线在 PR 分支上用 `visual-update` 生成。
- **事件日志是唯一事实源**：模型看到的一切都进日志，发给模型的历史只追加。媒体字节不进日志，只放引用；构建请求时按引用取。
- **权限清单**：
  - 插件用到 `ctx.storage` 必须声明 `permissions.storage`，由 `check:plugin-permissions` 规则 `perm-storage` 检查。
  - 新的中转能力不能被插件 `requires`。
- **新检查**：每一项新增的自动检查都要附违规 fixture，证明它会报错。
- **提交**：Conventional Commits，中文标题，正文每行 ≤100 字符；影响发布的改动附 changeset。
- **沙箱默认值**（可配置）：

  | 项 | 默认值 |
  |---|---|
  | `cpu` | 1 |
  | `memoryMb` | 2048 |
  | `diskMb` | 5120 |
  | `suspendAfterIdleMinutes` | 10 |
  | `destroyAfterInactiveDays` | 7 |
  | `maxCommandSeconds` | 7200 |
  | `egress` | `allowlist` |

  默认白名单：`registry.npmjs.org`、`pypi.org`、`files.pythonhosted.org`、`github.com`、`objects.githubusercontent.com`、`deb.debian.org`。
- **附件默认值**（可配置）：单个最大 20MB；类型限 `image/png`、`image/jpeg`、`image/gif`、`image/webp`、`application/pdf`、`text/plain`、`text/markdown`、`text/csv`；单条消息最多 10 个。

## Review Focus

1. **模型不支持的媒体。** 给不支持图片的模型发图片、给不支持文档的模型发 PDF，内核只发文字占位，绝不把字节发给模型。由 T3 的测试覆盖。
2. **两个副本同时首次使用同一对话的沙箱。** 只创建一个沙箱，另一边等待并复用，不会重复创建或泄漏容器。由 T7 的双副本测试覆盖。
3. **沙箱在对话中途休眠或已销毁。** 下一次沙箱工具调用会透明恢复。已销毁的沙箱会重建一个空的，并告诉模型「文件已不在」（英文提示），而不是报错卡住。由 T7 的测试覆盖。
4. **命令跑不完，或输出巨大。** 到超时即中止，输出截断或存档，沙箱仍可继续使用，运行不会挂起。由 T8 的测试覆盖。
5. **共享 agent 改技能。** 负责人批准前，其他用户的对话看不到改动；私有 agent 立即生效。由 T15 的测试覆盖。

---

## 第一段：对象存储、附件与媒体输入

### Task 1: SDK：`object-store@1`、`ctx.storage`、媒体块

**Files:**
- 修改 `packages/plugin-sdk/src/{capability,ctx,permissions,model,index}.ts`。
- 新建 `packages/plugin-sdk/src/storage.ts`。
- 测试 `packages/plugin-sdk/test/{storage,model-media}.test.ts`。
- 修改 `tools/checks/src/plugin-permissions.ts` 及其 fixture。
- changeset。

**Interfaces (Produces):**
```ts
// storage.ts
export const OBJECT_STORE_CAPABILITY = "object-store@1";
export interface ObjectHead { key: string; size: number; contentType: string; etag?: string; lastModified?: string }
export interface ObjectStore {
  put(key: string, body: Uint8Array | ReadableStream<Uint8Array>, opts: { contentType: string; size?: number; signal?: AbortSignal }): Promise<ObjectHead>;
  get(key: string, opts?: { signal?: AbortSignal; range?: { start: number; end?: number } }): Promise<{ head: ObjectHead; body: ReadableStream<Uint8Array> } | null>;
  head(key: string): Promise<ObjectHead | null>;
  delete(key: string): Promise<void>;                      // 不存在也算成功
  deletePrefix(prefix: string): Promise<number>;           // 用于组织数据删除
  list(prefix: string, opts?: { cursor?: string; limit?: number }): Promise<{ items: ObjectHead[]; cursor?: string }>;
  presignGet(key: string, opts: { ttlSeconds: number; downloadName?: string }): Promise<string>;
  presignPut(key: string, opts: { contentType: string; maxSize: number; ttlSeconds: number }): Promise<{ url: string; headers: Record<string, string> }>;
}
// ctx.ts：PluginContext.storage 与 ObjectStore 同形，但每个方法的第一个参数是 orgId，键会自动加前缀 plugins/<name>/<orgId>/
export interface PluginStorage { /* 与上面各方法同名，签名为 (orgId: string, key: string, ...) */ }

// model.ts：ContentBlock 增加两类
| { type: "image"; mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; source: MediaSource; name?: string }
| { type: "document"; mediaType: "application/pdf" | "text/plain" | "text/markdown" | "text/csv"; source: MediaSource; name?: string }
export type MediaSource = { kind: "base64"; data: string } | { kind: "ref"; attachmentId: string };
// 插件只会收到 base64：ref 由内核在构建请求时解析
// ModelInfo.capabilities 增加 documents?: boolean（缺省为 false）
export const MEDIA_LIMITS: { imageBytes: 5_242_880; documentBytes: 33_554_432 };
```
- `CAPABILITIES` 里的 `object-store` 保持「单选、中转」，去掉「预留」注释。
- `permissions.storage` 不再标为预留。
- `check:plugin-permissions`：`ctx.storage` 不再报 `perm-reserved`，`ctx.models` 仍报。新增规则 `perm-storage`：用到 `ctx.storage` 却没有声明 `permissions.storage` 时报错。

- [ ] **Step 1：先写失败测试。**
  - `validateMediaBlock`：类型不在列表里、base64 非法、超过 `MEDIA_LIMITS` 时，都返回错误。
  - `perm-storage` 违规 fixture 报错。
  - `perm-reserved` fixture 里的 `ctx.models` 仍然报错。
- [ ] **Step 2：** 运行 `pnpm vitest run packages/plugin-sdk tools/checks`，确认失败。
- [ ] **Step 3：** 实现，并导出 `validateMediaBlock(b: unknown): string[]`。
- [ ] **Step 4：** 运行 `pnpm vitest run packages/plugin-sdk tools/checks`、`pnpm typecheck`（内核暂时给 `ctx.storage` 一个占位实现，标 `TODO(M5 T2)`），确认通过。
- [ ] **Step 5：** 提交 `feat(plugin-sdk): object-store@1、ctx.storage 与图片 / 文档媒体块`。

### Task 2: `plugins/object-store-s3`、内核存储服务与 MinIO

**Files:**
- 新建 `plugins/object-store-s3/**`。
- 新建 `packages/testing/src/containers.ts` 中的 `startTestMinio()`。
- 修改 `docker/compose.dev.yaml`（加 MinIO 与建桶）。
- 新建 `packages/kernel/src/storage/{storage.service,prefix}.ts`。
- 修改 `ctx/create-ctx.ts`、`kernel.ts`、`config/schema.ts`。
- 测试 `plugins/object-store-s3/test/*`、`packages/kernel/test/storage/*`。

**Interfaces (Produces):**
```ts
// 内核
class StorageService {
  readonly available: boolean;                                   // 没有提供方时为 false
  forPlugin(plugin: string): PluginStorage;                      // 前缀 plugins/<plugin>/<orgId>/
  kernel(orgId: string): ObjectStore;                            // 前缀 kernel/<orgId>/
  deleteOrg(orgId: string): Promise<void>;                       // 删掉 kernel/<orgId>/ 与所有 plugins/*/<orgId>/
}
// 插件部署配置：{ endpoint?: string; region: string; bucket: string; accessKeyId: secret; secretAccessKey: secret; forcePathStyle: boolean; publicEndpoint?: string /* 浏览器可达的地址，预签名 URL 用它 */ }
startTestMinio(): Promise<{ endpoint: string; accessKey: string; secretKey: string; bucket: string; stop(): Promise<void> }>
```
- 键的校验：组织 id 与键都不能含 `..`、不能以 `/` 开头，长度 ≤ 1024，传进来的 orgId 必须是 UUID。任何拼出来会落到前缀之外的键，一律报错。
- 没有提供方时：声明了 `permissions.storage` 的插件不加载，原因写进 pending 列表；内核里依赖存储的功能返回 `storage.unavailable`（503）。

- [ ] **Step 1：先写失败测试。**
  - 插件用 MinIO 跑通全部方法。预签名 PUT 超过 `maxSize` 时，被存储拒绝。
  - 内核前缀隔离：插件 A 读不到插件 B、读不到别的组织；用 `../` 构造的键会报错。
  - `deleteOrg` 只删除该组织的对象。
  - 没有提供方时，声明了存储的插件进入 pending。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。compose 里加 `minio/minio` 与 `createbuckets` 一次性容器；README 补上本地启用方法。
- [ ] **Step 4：** 运行触及的测试和 `pnpm check`，确认通过。
- [ ] **Step 5：** 提交 `feat: S3 兼容对象存储插件、内核存储服务与 ctx.storage`。

### Task 3: 内核附件与媒体输入

**Files:**
- 迁移 `0021_attachments.sql`。
- 新建 `packages/kernel/src/conversations/attachments.{service,controller}.ts`。
- 修改 `conversations/events.ts`（`ContentBlockSchema` 加媒体块）、`conversations.service.ts`（`postUserMessage`）、`runtime/context/{build,tokens,compaction}.ts`、`config/schema.ts`、`errors.ts`。
- 测试 `packages/kernel/test/attachments/*`。

**Interfaces (Produces):**
```
表 capybara.attachments(id uuid pk, org_id, conversation_id null, account_id, name, content_type, size, object_key, status pending|ready, created_at, expires_at null)
POST /api/v1/orgs/:orgId/attachments            body {name, contentType, size} → {id, upload: {url, headers}, expiresAt}
POST /api/v1/orgs/:orgId/attachments/:id/finalize → {id, name, contentType, size}       // head 核对大小与类型，然后标记为 ready
GET  /api/v1/orgs/:orgId/attachments/:id/download → 302 到 presignGet（需对所属对话有访问权）
POST .../conversations/:id/messages 的 body 增加 files?: string[]（ready 附件 id，最多 10 个）
错误码：attachment.too_large 413、attachment.type_not_allowed 415、attachment.not_ready 409、attachment.not_found 404、storage.unavailable 503
```
- `postUserMessage` 把文件变成 `image` / `document` 块，`source: {kind:"ref", attachmentId}`，并把附件的 `conversation_id` 绑定到这个对话。
- 已绑定到别的对话的附件不能再用。
- **构建请求**：
  - 模型支持该类型（`vision` 对应图片，`documents` 对应 PDF 与文本）时，取出字节转成 base64。`text/*` 文档在模型不支持 documents 时，以截断文本内联。
  - 不支持时，替换成英文占位 `[Attached image "<name>" — this model cannot view images.]`。
  - 构建请求不改写日志，结果按日志确定。
- **token 估算**：图片按固定 1600 计，PDF 按页数 × 1000 计（拿不到页数时按字节 / 3）。
- **压缩**：摘要的转写把媒体块记为 `[image: name]`。
- 未绑定到对话的 pending 附件，由维护队列在 24 小时后删除（对象一并删除）。

- [ ] **Step 1：先写失败测试**（审查重点 1）：
  - 上传、finalize、发消息的完整流程。
  - 类型不对、超出大小、finalize 时大小不符，都被拒绝。
  - 支持视觉的模型收到 base64 图片；不支持的模型只收到占位，并断言请求里没有字节。
  - 别人对话的附件下载返回 404。
  - pending 附件过期后被清理。
  - 日志里只有引用，没有字节。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** 运行触及的测试、全量 `pnpm test`、`pnpm check`，确认通过。
- [ ] **Step 5：** 提交 `feat(kernel): 附件上传与图片 / 文档作为模型输入`。

### Task 4: 模型供应商插件映射媒体块

**Files:**
- 修改 `plugins/{anthropic,openai,openai-compatible}/src/map-request.ts`（openai-compatible 另外修改 `dialects.ts`）以及各插件的模型声明（`documents`）。
- 修改 `packages/testing/src/model-conformance.ts`（加媒体用例）。
- 修改 `skills/writing-model-providers`。

- 映射：
  - anthropic：`image` 映射为 `{type:"image", source:{type:"base64"}}`，`document` 映射为 `{type:"document", source:{type:"base64"}}`。
  - openai：`input_image`（`data:` URL）与 `input_file`。
  - openai-compatible：`image_url`（`data:` URL）；不支持 document 的方言，在声明里写 `documents:false`。
- 各插件按官方文档声明 `vision` / `documents`，在注释里写明出处与核实日期。
- 一致性套件新增「带图片的用户消息」用例，只有当模型声明了 `vision` 时才跑。

- [ ] **Step 1：** 先写失败测试，覆盖每个插件的映射前缀，以及一致性用例。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** 运行各插件测试，确认通过；真实接口（用 `CAPYBARA_TEST_*` 变量）跑一次带图片的请求，并在报告里写明模型。
- [ ] **Step 5：** 提交 `feat(plugins): 模型插件支持图片与文档输入`。

### Task 5: 网页：上传附件与在时间线中显示

**Files:**
- 修改 `apps/web/src/components/{Composer,MessageList}.tsx`，新建 `apps/web/src/lib/attachments.ts`。
- 设计组件：`AttachmentChip`（名称、大小、上传进度、移除）、`FileDrop`（拖放与粘贴区域）。按 design 四步走。
- i18n。
- 测试与 e2e。

- 输入框支持三种方式加文件：点击选择、拖入、粘贴。上传顺序是先登记、再用预签名 PUT 上传、最后 finalize，发送时附上已就绪的附件 id。
- 上传中不能发送；上传失败的附件显示错误，可以移除。
- 时间线显示消息附件：图片显示缩略图，其他文件显示文件卡片。点开图片或卡片，走 download 302。
- 超过类型或大小限制时，在前端提前拦下，提示文案与内核错误码一致。

- [ ] **Step 1：** 先写失败的组件测试，覆盖三种加文件方式、进度、错误、发送时带上的 id。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** e2e：e2e 环境里起 MinIO，上传一张 PNG 并发消息，用 model-fake 回显收到的块类型，断言时间线显示缩略图。
- [ ] **Step 5：** 提交 `feat(web): 对话中上传图片与文件`。

---

## 第二段：沙箱、沙箱工具与产物

### Task 6: SDK `sandbox@1` 契约

**Files:**
- 新建 `packages/plugin-sdk/src/sandbox.ts`，修改 `index.ts`。
- 测试 `packages/plugin-sdk/test/sandbox.test.ts`。
- changeset。

**Interfaces (Produces):**
```ts
export const SANDBOX_CAPABILITY = "sandbox@1";
export interface SandboxLimits { cpu: number; memoryMb: number; diskMb: number; egress: "none" | "allowlist" | "open"; allowHosts: string[] }
export interface SandboxHandle { id: string /* 提供方的实例 id */ }
export interface ExecResult { exitCode: number | null /* 超时或被中止为 null */; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }
export interface SandboxProvider {
  create(args: { name: string /* cap-<conversationId> */; image: string; limits: SandboxLimits; signal: AbortSignal }): Promise<SandboxHandle>;
  resume(h: SandboxHandle, signal: AbortSignal): Promise<"resumed" | "gone">;       // gone 表示提供方那边已经没有这个实例
  suspend(h: SandboxHandle, signal: AbortSignal): Promise<void>;                     // 文件必须保留
  destroy(h: SandboxHandle, signal: AbortSignal): Promise<void>;                     // 不存在也算成功
  exec(h: SandboxHandle, args: { command: string; cwd?: string; env?: Record<string,string>; timeoutMs: number; maxOutputBytes: number; signal: AbortSignal }): Promise<ExecResult>;
  readFile(h: SandboxHandle, path: string, opts: { maxBytes: number; signal: AbortSignal }): Promise<{ data: Uint8Array; truncated: boolean } | null>;
  writeFile(h: SandboxHandle, path: string, data: Uint8Array, signal: AbortSignal): Promise<void>;  // 父目录自动创建
  stat(h: SandboxHandle, path: string, signal: AbortSignal): Promise<{ size: number; isDir: boolean } | null>;
}
export function validateSandboxPath(p: string): string[];   // 必须是 /workspace、/skills 或 /tmp 下的绝对路径，不能含 ..
```
- `glob` / `grep` / `edit` 由内核用 `exec` 加 `readFile` / `writeFile` 组合实现，提供方只需实现以上原语。

- [ ] **Step 1：** 先写失败测试：`validateSandboxPath` 对 `../`、相对路径、`/etc`、编码过的 `..` 返回错误，对合法路径返回空数组。
- [ ] **Step 2：** 运行 `pnpm vitest run packages/plugin-sdk`，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** 运行 SDK 测试与 `pnpm typecheck`，确认通过。
- [ ] **Step 5：** 提交 `feat(plugin-sdk): sandbox@1 契约`。

### Task 7: 内核沙箱服务（按对话、懒创建、休眠与销毁）

**Files:**
- 迁移 `0022_sandboxes.sql`。
- 新建 `packages/kernel/src/sandbox/{sandbox.service,lifecycle}.ts`。
- 修改 `runtime/maintenance.ts`、`config/schema.ts`、`kernel.ts`、`errors.ts`。
- 新建一个测试用的假 `sandbox@1` 插件：`packages/kernel/test/fixtures/plugins/sandbox-fake`，把状态存在临时目录，模拟休眠与 `gone`。
- 测试 `packages/kernel/test/sandbox/*`（包括双副本）。

**Interfaces (Produces):**
```
表 capybara.sandboxes(conversation_id pk, org_id, provider text, handle jsonb, status creating|running|suspended|destroyed, last_used_at, created_at, suspended_at null, destroyed_at null)
配置 sandbox.{image, limits:{cpu, memoryMb, diskMb, maxCommandSeconds, suspendAfterIdleMinutes, destroyAfterInactiveDays, egress, allowHosts}}
class SandboxService {
  readonly available: boolean;
  withSandbox<T>(ctx: { orgId: string; conversationId: string }, fn: (h: SandboxHandle, p: SandboxProvider, info: { fresh: boolean; recreated: boolean }) => Promise<T>, signal: AbortSignal): Promise<T>;
  suspendIdle(now: Date): Promise<number>;      // 由维护队列调用
  destroyInactive(now: Date): Promise<number>;  // 由维护队列调用
  destroyFor(conversationId: string): Promise<void>; // 对话删除或离职处理时调用
}
错误码：sandbox.unavailable 503
```
- `withSandbox` 的流程：
  1. 先拿 Redis 锁 `capk:sandbox:<conversationId>`，超时 60 秒、续租。
  2. 读表：没有记录就创建；`suspended` 就恢复，恢复结果是 `gone` 时重建，并返回 `recreated: true`；`destroyed` 也重建。
  3. 执行完更新 `last_used_at`。

  同一对话的并发调用在锁上排队，执行本身串行。
- 重建后附件重新复制进沙箱，这一步由 T8 处理。`recreated` 由 T8 转成给模型的英文提示。
- 维护队列（`cap-kernel-maintenance`）新增两个定时任务：`sandbox-suspend-idle`（每分钟）和 `sandbox-destroy-inactive`（每小时）。job id 不含 `:`。
- 组织删除、对话删除时销毁对应沙箱。

- [ ] **Step 1：先写失败测试**（审查重点 2、3）：
  - 双副本同时首次调用，只创建一次。
  - 空闲到期后被休眠，下次调用会恢复。
  - 提供方返回 `gone` 时重建，`recreated` 为 true。
  - 不活跃到期后被销毁，下次调用得到一个全新沙箱。
  - 没有提供方时返回 503。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** 运行触及的测试与全量 `pnpm test`，确认通过。
- [ ] **Step 5：** 提交 `feat(kernel): 按对话的沙箱服务（懒创建、休眠、销毁）`。

### Task 8: 沙箱内置工具与产物

**Files:**
- 新建 `packages/kernel/src/tools/builtins/sandbox/{bash,read,write,edit,glob,grep,deliver}.ts`。
- 修改 `kernel.ts`（注册）、`agents/definition.ts`（可选工具）、`conversations/events.ts`（`artifact_created`）、`orgs/settings.service.ts`（`sandboxToolPolicy: "allow" | "ask"`，默认 allow）。
- 新增 `GET .../conversations/:id/artifacts/:artifactId/download`。
- 测试 `packages/kernel/test/tools/sandbox/*`。

**Interfaces (Produces):**
```
工具 key：sandbox.bash {command, timeoutSeconds?(≤ maxCommandSeconds)}；sandbox.read {path, offset?, limit?}；sandbox.write {path, content}；
         sandbox.edit {path, oldText, newText, replaceAll?}；sandbox.glob {pattern, path?}；sandbox.grep {pattern, path?, glob?, ignoreCase?}；
         sandbox.deliver {path, name?}
事件 artifact_created {artifactId, name, contentType, size, objectKey, sourcePath, callId}
```
- 默认策略：组织设置为 allow 时，这些工具都是 allow；为 ask 时，除 `read` / `glob` / `grep` 外都是 ask。
- 工具描述、错误文案用英文，并遵守 `check` 的工具设计规则。
- **输出处理**：
  - `bash` 输出超过 30000 字符时，走现有的输出存档。
  - 命令超时则中止，返回 `timedOut`，沙箱仍可使用。
- **沙箱状态提示**：首次使用、重建后，在工具结果开头加英文说明。例如 `"Sandbox was recreated; previous files are gone."`。
- **附件同步**：调用前把本对话的附件复制到 `/workspace/attachments/<name>`，用标记文件记录已复制的附件，避免重复。
- **`deliver`**：
  - 文件最大 100MB，可配置。
  - 读出文件并 `put` 到存储 `kernel/<org>/artifacts/<conversationId>/<artifactId>`，写入 `artifact_created` 事件，返回英文确认。
  - 下载接口的访问规则与对话流相同，响应为 302 到 presignGet，带 `downloadName`。
- 所有路径都先用 `validateSandboxPath` 检查。
- 每个工具都返回 `display` 双语摘要。

- [ ] **Step 1：先写失败测试**（审查重点 4）：用假沙箱插件测 7 个工具的行为。
  - 超时：中止后，下一次调用仍成功。
  - 巨大输出：被存档。
  - 越界路径：被拒绝。
  - `deliver`：写出事件与对象，下载权限正确。
  - 组织策略设为 ask 时：会产生审批。
  - 附件出现在 `/workspace/attachments`。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** 运行触及的测试、`pnpm check`（包括工具设计规则），确认通过。
- [ ] **Step 5：** 提交 `feat(kernel): 沙箱内置工具与产物交付`。

### Task 9: `plugins/sandbox-docker`

**Files:**
- 新建 `plugins/sandbox-docker/**`，其中 `image/Dockerfile` 是唯一的沙箱镜像，E2B 模板也用它。
- 新建 `docker/sandbox-proxy/`：socket 代理配置，只放行容器生命周期与 exec 相关接口。
- 修改 `docker/compose.dev.yaml`，加入可选的 profile `sandbox`。
- 测试 `plugins/sandbox-docker/test/*`。

- 部署配置：

  | 键 | 说明 |
  |---|---|
  | `endpoint` | 代理地址 `tcp://sandbox-proxy:2375` 或 `unix://` |
  | `runtime` | `runc` 或 `runsc` |
  | `network` | 沙箱网络名 |
  | `egressProxyImage` | 出站代理镜像 |
  | `volumeDriver?` | 卷驱动，可选 |

- 用 Docker Engine HTTP API，可以直接 fetch，也可以用一个轻量客户端库；选哪个由实现者定，在报告里说明。
- **生命周期**：
  - `create`：创建卷与容器，按 limits 设置 cpu、内存、卷大小（`--storage-opt size`，驱动不支持时在 README 里写明）。
  - `suspend`：停止容器（文件留在卷上）。
  - `resume`：启动容器；容器不存在时返回 `gone`。
  - `destroy`：删除容器与卷。
- **出站**：
  - `none`：没有网络。
  - `allowlist`：沙箱只连得到内部网络上的出站代理容器，代理按 `allowHosts` 放行，`HTTP_PROXY` / `HTTPS_PROXY` 已在环境变量里设好。
  - `open`：普通 bridge 网络。
- 插件不得挂 docker.sock，只经 endpoint 访问。

- [ ] **Step 1：先写失败测试**（需要 Docker；CI 的 ubuntu-latest 有）：
  - 用 runc 跑完整生命周期：create → exec → write / read → suspend → resume，文件仍在 → destroy。
  - 超时中止。
  - `allowlist`：放行的域名可以访问，没放行的被拒；用 testcontainers 起一个本地 HTTP 服务作为放行目标，域名映射写进代理配置。
  - `none`：没有网络。
  - runsc 用例：只在环境有 runsc 时运行，否则跳过。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** 运行插件测试，再与内核联调：用真实插件跑 T8 的一组冒烟用例。
- [ ] **Step 5：** 提交 `feat(plugins): Docker 沙箱插件（runc / runsc、socket 代理、出站白名单）`。

### Task 10: `plugins/sandbox-e2b`

**Files:**
- 新建 `plugins/sandbox-e2b/**`、`packages/testing/src/fake-e2b.ts`。
- 测试 `plugins/sandbox-e2b/test/*`，真实接口测试放在 `test/live`。

- 先查 E2B 文档，在注释里写明出处与核实日期：
  - sandbox create / connect / pause / resume / kill；
  - 命令执行与超时；
  - 文件读写；
  - 资源规格；
  - 网络出站控制；
  - 自托管时 `apiUrl` 怎么配。
- **配置**：部署配置为 `{ apiKey: secret, apiUrl?: string, template: string }`，模板由 `plugins/sandbox-docker/image/Dockerfile` 构建，README 写明步骤。
- **生命周期映射**：`suspend` 对应 pause，`resume` 对应 resume / connect，实例过期返回 `gone`。
- **出站**：映射到 E2B 的网络控制；不支持按域名白名单时，`allowlist` 退化为 `none` 并打告警，并在 README 写明（C4）。

- [ ] **Step 1：** 先写失败测试：用假 E2B 服务覆盖各方法与错误映射。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** 运行插件测试，确认通过；真实接口测试只在有 `CAPYBARA_TEST_E2B_API_KEY` 时运行，否则跳过。
- [ ] **Step 5：** 提交 `feat(plugins): E2B 沙箱插件`。

### Task 11: 网页：产物标签与沙箱状态

**Files:**
- 修改 `apps/web/src/components/chat-panel/{ChatPanel,ContextTab}.tsx`，新建 `ArtifactsTab.tsx`、`lib/artifacts.ts`。
- 设计组件：如需新增文件卡片或预览组件，按四步走。
- 修改 i18n。
- 测试与 e2e。

- 「产物」标签从对话日志的 `artifact_created` 事件重建：显示名称、类型、大小、时间；图片可以预览，文本类文件显示前若干行，所有产物都能下载。有产物时才显示这个标签，标签上带数量。
- 上下文标签加上沙箱状态：未创建、运行中或已休眠，以及最近使用时间。数据来自新接口 `GET .../conversations/:id/sandbox`，返回 `{status, lastUsedAt}` 或 404。
- 收到 `artifact_created` 事件时实时更新，不需要刷新。

- [ ] **Step 1：** 先写失败的组件测试。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** e2e：用 model-fake 脚本调用 `sandbox.write` 和 `sandbox.deliver`（沙箱用假插件），断言产物标签出现并能下载。
- [ ] **Step 5：** 提交 `feat(web): 产物标签与沙箱状态`。

### Task 12: 第二段验收

- 新建 `packages/kernel/test/sandbox/m5-segment2.dual.test.ts`，用双副本和真实 `sandbox-docker` 插件（runc）走完以下流程：
  1. 上传附件；
  2. agent 用 `sandbox.bash` 处理附件；
  3. 用 `deliver` 交付产物；
  4. 杀掉执行这次运行的副本，另一个副本接着续跑，沙箱被复用、文件还在；
  5. 空闲到期后沙箱被休眠，再次调用时恢复。
- 更新人工验收清单，加入 runsc 与 E2B 的真实运行步骤。
- [ ] 提交 `test: M5 第二段验收`。

---

## 第三段：技能

### Task 13: 技能格式、技能库与存储

**Files:**
- 迁移 `0023_skills.sql`。
- 新建 `packages/kernel/src/skills/{skills.service,skills.controller,package}.ts`，新建 `packages/plugin-sdk/src/skill.ts`（纯解析函数）。
- 测试 `packages/kernel/test/skills/*`、`packages/plugin-sdk/test/skill.test.ts`。

**Interfaces (Produces):**
```
表 capybara.skills(id uuid pk, org_id, scope org|agent, agent_id null, name, description, current_version int, created_by, created_at, deleted_at null, unique(org_id, scope, coalesce(agent_id,…), name) where deleted_at is null)
表 capybara.skill_versions(skill_id, version, manifest jsonb {name, description, files:[{path,size,sha256}]}, object_prefix, created_by, created_at, pk(skill_id,version))
SDK：parseSkillMd(text: string): { name: string; description: string; body: string } | { errors: string[] }   // YAML frontmatter：name 小写字母、数字、连字符，≤64；description ≤1024（与 Agent Skills 一致，实现时核实）
     validateSkillPackage(files: {path: string; size: number}[]): string[]                                     // 必须有 SKILL.md；单文件 ≤ 10MB；总量 ≤ 50MB；路径不能越界
POST /api/v1/orgs/:orgId/skills          (admin) body: 用预签名 PUT 上传的 zip 对应的 attachment id → 解包校验后，创建技能或新增一个版本
GET  /api/v1/orgs/:orgId/skills          → 组织技能列表；GET /skills/:id 返回详情、各版本与文件列表
DELETE /api/v1/orgs/:orgId/skills/:id    (admin，R3 删除动作要求确认，由网页二次确认)
```
- agent 定义增加 `skills: { orgSkills: string[] /* 技能 id */ }`，作为新版本保存。agent 自己的技能放在 `scope=agent` 的记录里，自动对该 agent 生效。

- [ ] **Step 1：** 先写失败测试，覆盖：
  - frontmatter 解析与校验；
  - zip 包里的越界路径、超限、缺少 SKILL.md；
  - 上传后生成的版本与对象；
  - 非 admin 上传组织技能返回 403。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** 运行触及的测试，确认通过。
- [ ] **Step 5：** 提交 `feat: 技能格式解析与组织技能库`。

### Task 14: 运行时：技能目录、`skill_load` 与进沙箱

**Files:**
- 修改 `runtime/context/build.ts`（技能目录放进系统提示的缓存段）。
- 新建 `tools/builtins/skill-load.ts`。
- 修改 `sandbox/sandbox.service.ts` 的调用方：技能文件按需复制进沙箱。
- 测试。

- **技能目录**：系统提示里列出 agent 可用技能的 `name` 和 `description`（组织技能里被该 agent 选中的，加上 agent 自己的技能），英文说明「需要时调用 `skill_load`」。按名字排序，保证缓存稳定。
- **`skill_load {name}`**：
  1. 返回 SKILL.md 正文和文件清单。
  2. 如果技能带脚本或其他文件，同时把整个技能复制到沙箱 `/skills/<name>/`（只读），并在结果里告诉模型路径。
  3. 没有沙箱提供方时，只返回正文，并说明脚本不可用。
- **生效版本**：技能目录和 `skill_load` 都取「此刻对这个对话生效的版本」，具体由 T15 定义。

- [ ] **Step 1：先写失败测试：**
  - 系统提示里出现技能目录；
  - `skill_load` 返回正文；
  - 带脚本的技能出现在沙箱里；
  - 没有沙箱时降级；
  - 未选中的组织技能不可见。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** 运行测试，确认通过。
- [ ] **Step 5：** 提交 `feat(kernel): 技能目录与 skill_load`。

### Task 15: agent 自写技能与 R4 审批

**Files:**
- 迁移 `0024_skill_changes.sql`。
- 新建 `tools/builtins/skill-write.ts`、`skills/changes.service.ts`。
- 修改 `tools/policy.ts`（`R3_FIXED_ASK_TOOL_KEYS` 加入 `skill.write`，用于共享 agent）。
- 新增收件箱接口 `GET /api/v1/orgs/:orgId/inbox`：汇总工具审批与技能变更。
- 测试。

**Interfaces (Produces):**
```
表 capybara.skill_change_requests(id, org_id, agent_id, skill_id null, proposed_version jsonb, object_prefix, requested_by_account, requested_in_conversation, status pending|approved|rejected|cancelled, decided_by, decided_at, created_at)
工具 skill.write {name, description, files: [{path, content}]}（只写 agent 自己的技能；只支持文本文件，单个技能 ≤ 1MB）
POST /api/v1/orgs/:orgId/skill-changes/:id/decide {decision: approve|reject}   // 只有该 agent 的负责人可以决定（R2：agent 不能审批）
```
- **R4，私有 agent**（`visibility = private`）：`skill.write` 直接生成新版本，立即生效。
- **R4，共享 agent**：
  1. `skill.write` 是 R3 固定 ask：先由触发这次对话的人确认工具调用。
  2. 确认后生成一条变更申请，进负责人的收件箱。
  3. 负责人批准前：发起人自己的这个对话可以试用新版本，其他对话照旧使用旧版本。
  4. 批准后，新版本对所有对话生效；拒绝后，草稿删除。
- 审计 `skill.change_requested` / `skill.change_decided`，覆盖整条链（R6）。

- [ ] **Step 1：先写失败测试**（审查重点 5）：
  - 私有 agent 写技能后立即生效。
  - 共享 agent 写技能时：先要工具确认；生成变更申请；发起对话能看到新版本，别的对话看不到；负责人批准后都能看到；非负责人决定返回 403；拒绝后保持原样。
  - 收件箱汇总两类事项。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** 运行触及的测试与全量测试，确认通过。
- [ ] **Step 5：** 提交 `feat(kernel): agent 自写技能与共享 agent 的技能变更审批`。

### Task 16: 网页：技能库、agent 技能与收件箱

**Files:**
- 新建页面 `apps/web/src/app/[locale]/(app)/skills/{page,[id]/page}.tsx`（ListPage / DetailPage）。
- 修改 agent 表单，加技能选择。
- 修改收件箱页面：显示技能变更，展示文件差异。差异组件如需新增，按 design 四步走。
- 修改顶栏或设置导航，加入「技能」。
- i18n、测试与 e2e。

- 技能库页面：列表；上传 zip（复用附件上传）；详情页显示 SKILL.md 正文渲染为纯文本、文件列表和版本；删除需二次确认。只有 admin 能上传和删除，成员只能查看。
- agent 表单：多选组织技能；agent 自己写的技能只读展示。
- 收件箱：技能变更卡片显示 agent、发起人、变更的文件和差异，提供批准 / 拒绝。

- [ ] **Step 1：** 先写失败的组件测试。
- [ ] **Step 2：** 运行测试，确认失败。
- [ ] **Step 3：** 实现。
- [ ] **Step 4：** e2e：admin 上传技能，agent 选中它；用 model-fake 脚本调用 `skill_load`，断言时间线的摘要。
- [ ] **Step 5：** 提交 `feat(web): 技能库、agent 技能与收件箱的技能变更`。

### Task 17: 第三段验收、文档与路线图

- 新建 `packages/kernel/test/skills/m5-segment3.dual.test.ts`，覆盖：共享 agent 写技能，审批跨副本生效；`skill_load` 把脚本放进沙箱并执行（用假沙箱插件）。
- 新增技能文档：
  - `skills/writing-sandbox-providers`：`sandbox@1` 契约、生命周期、出站、测试。
  - `skills/writing-object-store-providers`，可以并进上一份，由实现者定。
  - 更新 `writing-model-providers`（媒体块）、`writing-tools`（沙箱工具、技能工具）、`writing-plugins`（`ctx.storage`、`perm-storage`）。
- 更新 `AGENTS.md` 规则速记、README（MinIO、沙箱启用、技能），以及路线图（M5 完成，并列出推迟项）。
- 更新人工验收清单：Docker runsc、E2B、带图片的真实模型请求。
- [ ] 提交 `test: M5 第三段验收` 与 `docs: M5 对象存储、沙箱与技能文档`。

---

## 执行顺序

1. **第一段**：T1 → T5 串行。
2. **第二段**：T6 → T12。T9 和 T10 都只依赖 T6，但仍串行做（实现者不并行）。第二段开始前做一次第一段整体审查。
3. **第三段**：T13 → T17。T14 依赖 T7 / T8，T15 依赖 T13。
4. **收尾**：全分支终审，然后统一修复一轮。

真实接口验收（带图片的模型、runsc、E2B）在凭据到位后补跑。
