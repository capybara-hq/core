---
name: writing-tools
description: 给 agent 新增或修改工具时使用：插件用 ctx.tools.register 注册工具（参考 plugins/todo）、实现 connector@1 连接器（参考 plugins/connector-mcp）、内核内置工具。工具命名与 key、英文描述与可执行的错误文案（pnpm check 的工具设计规则）、注解与默认策略、defaultPolicy、ToolError、超时与中止、输出大小与存档（read_tool_output、{"$output": id}）、InputRequired 与续跑、插件须在组织启用。
---

# 写工具

通用的插件写法（清单、配置、ctx、多副本禁令、双副本测试）见 `skills/writing-plugins`，这里只讲工具特有的部分。参考实现：

- 插件工具：`plugins/todo`（一个 `write` 工具，整表写入本插件 schema，默认 allow）。
- 连接器：`plugins/connector-mcp`（`connector@1`，把远端 MCP 服务接成「应用」）；`plugins/connector-openapi`（OpenAPI 3.0 / 3.1 描述的 HTTP API，每个 operation 一个工具，实现了 `inspect`）。
- 内核内置工具：`packages/kernel/src/tools/builtins`（`ask_user`、`read_tool_output`）。

工具的执行全部经内核管线 `packages/kernel/src/tools/pipeline.ts`：解析 `{"$output": id}` 引用 → ajv 校验参数 → 策略判定（allow / ask / deny）→ 写 `tool_call_started` → 执行（超时 + 中止）→ 渲染结果 → 超大结果转存 → 写 `tool_result`。插件只管「做事并返回结果」，审批、超时、存档、审计、打码都是内核的事，**不要在插件里重复实现**。

## 三种工具来源与 key

模型看到的工具名（key）必须匹配 `^[a-zA-Z0-9_-]{1,64}$`：

| 来源 | key | 名字规则 |
|---|---|---|
| 内置 | 名字本身：`ask_user`、`read_tool_output`（`tool_search` 在第二段） | — |
| 插件 | `<plugin>__<tool>`，如 `todo__write` | `spec.name` 匹配 `^[a-zA-Z0-9_-]{1,40}$`（`PLUGIN_TOOL_NAME`） |
| 应用（连接器） | `<appSlug>__<tool>`，如 `docs__search` | slug `^[a-z][a-z0-9_]{0,23}$`，不含连续 / 结尾下划线；工具名由远端决定 |

key 超长或含非法字符时**不截断、不猜**：保存 agent 时报 `validation_failed`；应用工具在安装 / 刷新时停用并在 `issues` 里写原因。名字用小写 + 下划线的动词短语（`write`、`search`、`delete_doc`），不要把插件名再写进工具名（key 已带前缀）。

agent 定义按引用选工具：`{kind:"builtin",name}`、`{kind:"plugin",plugin,name}`、`{kind:"app",appId,tools:"all"|string[]}`。运行时每步实时解析（`ToolRegistry.forAgent`），不可用的工具（插件未启用、应用停用 / 删除、工具待复核等）跳过并写一条英文 `reminder`（`The following tools are unavailable in this run: <key> (<reason>), …`），模型仍调用它时得到 `Tool "<key>" is unavailable: <reason>.`，整轮不失败。

## 插件工具：`ctx.tools.register`

```ts
import { definePlugin, ToolError, type ToolSpec } from "@capybara-hq/plugin-sdk";

const SPEC: ToolSpec = {
  name: "write",
  description:
    "Create and update the task list for the current conversation. Use it for work with three or " +
    "more steps … Do not use it for a single trivial task.",
  inputSchema: { type: "object", properties: { /* … */ }, required: ["todos"], additionalProperties: false },
  defaultPolicy: "allow",
};

export default definePlugin({
  name: "todo",
  // …
  setup(ctx) {
    ctx.tools.register(SPEC, async (input, call) => {
      // call: { orgId, accountId, agentId, conversationId, callId, signal, resume? }
      // …校验、写 ctx.db…
      return { content: [{ type: "text", text: "Todo list updated (3 items): …" }] };
    });
  },
});
```

- **只能在 `setup` 期间注册**，之后调用抛错；同一插件内名字不可重复；`validateToolSpec` 在注册时校验（名字、非空描述、inputSchema 为对象、`defaultPolicy` 只能 `allow` / `ask`）。
- **插件工具只在启用了该插件的组织可用**（Ruling A5，与模型供应商不同）：组织 admin 需 `PUT /api/v1/orgs/:orgId/plugins/<plugin> {"enabled": true}`。未启用时 agent 仍可保存引用（只校验插件已注册），运行时按「不可用」处理（见上）。连接器是部署级的，不需要按组织启用。
- 处理函数里的状态遵守多副本纪律：持久数据进 `ctx.db`（todo 按 `conversationId` 一行 upsert），不放模块级 Map。
- 处理函数**必须响应 `call.signal`**（超时 `tools.timeoutMs` 与 run 中止合并后的信号）：把它传给 `fetch` / 数据库查询等。内核与处理函数竞速，不响应也会按时返回超时结果，但你的副作用可能还在跑。
- 参数在调用前已按 `inputSchema` 用 ajv（2020-12）校验过；不合法时模型拿到全部错误路径 + 完整 inputSchema，处理函数不会被调用。处理函数里再用 zod 解析一次拿类型，解析失败抛 `ToolError`（见下）。

## 描述与错误文案（模型可见，一律英文）

`pnpm check`（`check:tool-design`，`tools/checks/src/tool-design.ts`）静态检查：

| 规则 id | 要求 |
|---|---|
| `tool-description` | `ctx.tools.register(spec, …)` 与内置 `BuiltinTool` 字面量的 `spec.description` 是字符串字面量（可 `+` 拼接、可引用本文件内的 const），≥ 20 字符，不含中文 |
| `tool-error-actionable` | `new ToolError(msg)` 的 msg 是字面量 / 模板（或本文件内的常量、函数返回值），且含建议动词 `use` / `call` / `retry` / `check` / `ask` / `pass` / `provide` 之一 |

检查之外的写法要求：

- **描述说清三件事**：做什么、什么时候用、什么时候不该用；有副作用的说明副作用（如「Each call replaces the whole list」）。inputSchema 每个字段写 `description`，给例子。
- **错误给事实与下一步**：说清哪里错了、模型下一步该做什么（换参数重试、先调用别的工具、请用户处理）。例：`Invalid todos: pass an array of items with content, status and activeForm, where status is pending, in_progress or completed.`；`Authentication failed for this app; ask the user to reconnect it.`
- 不在错误里回显凭据、内部路径或堆栈；不做模糊匹配（「你是不是想调用 X」）。
- 界面上显示的文案（表单标题、字段标签）可给 `{ zh, en }` 双语，走 i18n；给模型的只用英文。

## 注解与默认策略

`ToolSpec.annotations`（与 MCP 对齐）：`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`、`requiresUserInteraction`。

- 默认策略：插件 / 内置工具声明了 `defaultPolicy` 就用它；否则按注解推导 —— `readOnlyHint: true` → `allow`，其余（含无注解、destructive）→ `ask`（`policyFromAnnotations`）。应用工具在安装时按注解推导并存进 `app_tools.default_policy`，管理员可改。
- 只有确实无副作用、或副作用只落在本会话的工具才声明 `defaultPolicy: "allow"`（如 todo）；拿不准就别声明，让它走 `ask`。
- 最终策略在**执行那一刻**取最严者：组织默认策略、agent 的 `toolPolicies`（只能收紧为 `ask` / `deny`）、`requiresUserInteraction` 与 R3 清单（至少 `ask`，记住的授权对它们无效）；用户记住的授权（本会话 / 以后都允许）只能把 `ask` 放行为 `allow`，`spec_hash` 变了即失效，不越过 `deny`。
- `ask` → 内核建审批、run 进入 `waiting`（不占会话锁与配额），批准后从 checkpoint 续跑；拒绝 / 超时（`tools.approvalTimeoutHours`）/ 等待中被中止一律按拒绝写 `tool_result`。插件无需关心。

## 结果、`ToolError` 与失败

- 返回 `{ content: ToolContent[], isError? }`。`text` 原样拼接；`image` / `resource_link` 给模型的是类型说明（不丢弃）。`isError: true` 表示「工具执行了但结果是错误」，内容照样给模型。
- 抛 `ToolError(message)`：message **原样**给模型（所以必须英文、可执行）。可选第二个参数 `{ kind: "unavailable" }` 表示远端不可用（连不上、HTTP 5xx），只对连接器有意义：计入应用熔断；缺省 `kind: "error"`（参数错误、业务错误、鉴权失败等）说明远端可达，不计入熔断。
- 抛其他错误：模型只看到 `Tool <key> failed (<ErrorName>). The operation may not have completed; check before retrying or try another approach.`，错误详情进日志（经打码）。不要依赖异常消息传话。
- 超时：`Tool <key> timed out after <n>s. The operation may or may not have completed; verify before retrying.`
- **有副作用不盲目重跑**（spec 4.3）：内核在执行前写 `tool_call_started`。进程在执行中崩溃，续跑时这次调用的结果写为 `Result unknown: the call was interrupted before a result was recorded. Verify the outcome before retrying.`，**不会再调用你的处理函数**。所以处理函数无需为「被内核重放」做幂等，但模型可能看到「结果未知」后自己重试 —— 有条件的话让写操作天然幂等（如 todo 的整表覆盖）。

## 输出大小与存档

- 渲染后的结果超过 `tools.outputSpillChars`（默认 50000 字符）时，全文存进输出存档（`tool_outputs`，保留 `tools.outputRetentionDays` 天），模型只见前 `tools.outputPreviewChars`（默认 2000）字符与说明：`[Output truncated: … Full output id: <id>. Use read_tool_output to page through it, or pass {"$output":"<id>"} as a tool argument.]`。
- 模型用内置工具 `read_tool_output {id, offset?, limit?, charOffset?}` 按行分页读存档（每次不超过 `tools.maxResultReadChars`）。
- 参数里任意位置的 `{"$output": "<id>"}`（对象恰好只有这一个键）在校验前被替换为该存档全文，所以大结果可以直接传给下一个工具，不经模型上下文。处理函数看到的就是替换后的值。
- 存档**只属于产生它的会话**：`read_tool_output` 与 `$output` 只能读同一会话（且同一组织）的存档，别的会话的 id 一律按「not found or expired」处理（会话之间可见范围不同，不能借 id 跨会话读结果）。
- 因此插件**不要自己截断**大结果或自造分页；返回完整文本即可。真正无界的数据（整库导出）在工具层面设上限或分页参数，并在描述里写明。

## 需要用户输入：`InputRequired` 与续跑

处理函数可以返回 `{ kind: "input_required", form, state? }` 而不是结果：内核校验表单（`validateInputForm`，字段 schema 只用 ParamSchema 子集，枚举可 `multiSelect` / `allowOther`）、建输入请求、run 暂停。用户提交后（或超时 / 取消），内核**用同一 input 再次调用**该处理函数，并带上 `call.resume = { state, answer }`（超时 / 取消时 `answer` 为 `null`）。

```ts
async (input, call) => {
  if (!call.resume) {
    return { kind: "input_required", form: { title: { zh: "确认", en: "Confirm" }, fields: [ /* … */ ] }, state: { step: 1 } };
  }
  if (call.resume.answer === null) throw new ToolError("The user did not answer; ask again later or try another approach.");
  // 用 call.resume.state / answer 继续
}
```

- `state` 可 JSON 序列化、≤ 16 KB；它存在 PG，续跑可能在另一个副本上，**不要把续跑需要的东西放内存**。
- 同一调用最多连续请求输入 3 次，第 4 次 → `Tool requested user input too many times.`
- 内置 `ask_user` 就是用这套机制实现的，可作参考。

## 连接器：`connector@1`

连接器把一类远端服务（如 MCP）接成组织里的「应用」：插件 `provides: [CONNECTOR_CAPABILITY]`，`setup` 里 `ctx.provide(CONNECTOR_CAPABILITY, connector)`。契约在 `packages/plugin-sdk/src/connector.ts`：

```ts
interface Connector {
  kind: string;                 // 存进 apps.connector，如 "mcp"
  endpointSchema: ZodTypeAny;   // 应用 endpoint 的校验（内核安装时调用）
  open(args: { endpoint; auth(): Promise<AuthInjection>; onUnauthorized(): Promise<void>; signal; onToolsChanged?(): void }): Promise<ConnectorSession>;
  // 可选：不带凭据读端点描述，给安装向导（POST /orgs/:orgId/apps/preview）预填认证方式、勾选操作
  inspect?(args: { endpoint; signal }): Promise<{ authHints: AuthHint[]; operations?: { id; method; path; summary? }[] }>;
}
interface ConnectorSession {
  listTools(): Promise<ToolSpec[]>;
  callTool(name, input, signal): Promise<ToolResult>;
  listResources?(); readResource?(uri);   // 可选；有则内核补 <slug>__list_resources / <slug>__read_resource
  close(): Promise<void>;
}
```

实现要点（照 `plugins/connector-mcp/src/session.ts`）：

- **会话按次打开**：内核每次 `listTools`（安装 / 刷新）或每次工具调用都 `open` → 用 → `close`，连接器**不缓存连接、不持有进程内会话**（多副本下下一次调用可能在另一个副本）。`close` 尽快返回（内核最多等 5 秒，出错只记 warn），失败不影响结果。
- **每个出站请求前调用 `auth()`**，把返回的 `headers` / `query` 合并进请求；不要在会话开头取一次就一直用（凭据可能刷新）。凭据由内核解密并只在这一刻出现，连接器不存、不记日志。
- **401 → 调用一次 `onUnauthorized()`，用新的 `auth()` 重试一次**；仍 401 抛 `ToolError("Authentication failed for this app; ask the user to reconnect it.")`。不要循环重试；其他错误也不要在插件里重试（重试与熔断由内核管）。
- **不跟随重定向**（`fetch(…, { redirect: "manual" })`，3xx 一律报错）：跟随会把请求体与注入的凭据头带到别的源。端点 URL 只接受 https（connector-mcp 的部署配置 `allowInsecureLoopback` 只在开发 / 测试打开本机 http）；端点固定头禁止 `Authorization` / `Cookie` 等凭据头（凭据走应用认证设置、加密存储）。
- **打码**：内核在写事件 / 存档之前，用本次调用实际注入的凭据值给应用工具的结果与错误打码（`[REDACTED]`），日志也有打码；但连接器仍不得主动把凭据写进错误消息或日志。上游 HTTP 错误给模型只说状态码，正文截断后记 warn 日志。
- 映射远端工具清单时保留 `annotations`（内核据此推导默认策略），缺描述用 title / name 兜底并 warn；远端 JSON-RPC 错误 → `ToolError` 带服务说明。
- 远端的 `inputSchema` 不受信任：内核校验参数前去掉 `pattern` / `patternProperties`（按 additionalProperties 语义放宽）/ `format`，超过 64 KB 或嵌套超过 32 层的 schema 不校验（记 warn），每个 schema 用独立的 Ajv 实例（`$id` 不互相冲突）。工具定义按指纹存进 `capybara.tool_specs`（安装 / 刷新与每次模型请求时），刷新改了定义后早先的请求仍可还原。
- 端点配置对组织成员可见：固定头与 URL query 里不能放凭据（`x-api-key`、`api-key`、`x-auth-token`、`authorization` 各变体、`*-token`、`*-secret` 等头，`key` / `api_key` / `token` / `access_token` / `secret` 等 query 参数，URL 用户信息），内核在安装时一律 400 拒绝并提示改用凭据设置；没有 `apps.manage` 的人读应用时只看到不带 query 的 URL 与头名（`headerNames`）。
- 尊重 `signal`（`open` 的与 `callTool` 的），超时由内核的 `tools.timeoutMs` 决定，SDK 自带的请求超时设得足够长、不要抢在内核前面。
- **OAuth 全在内核**（`packages/kernel/src/tools/oauth/`），连接器照上面两条做即可：`auth()` 返回的 Bearer 由内核在过期前 60 秒刷新；`onUnauthorized()` 在 Redis 锁 `capk:oauth-refresh:<orgId>:<appId>:<owner>` 内强制刷新（别的副本已刷新则直接用新 token，不并发刷新），refresh 被拒 → 凭据删除、调用得到「需要连接」。认证方式 `oauth_code`（个人，`discovery: "mcp"` 走 RFC 9728 → RFC 8414 发现，`client: "dcr"` 安装时 RFC 7591 注册，不支持 DCR → 502 `app.connect_failed` 带 `dcr_unsupported`，改用 `client: "manual"` + `credential: { clientId, clientSecret? }`）与 `oauth_client`（组织，客户端凭据流）；都要求配置 `http.publicUrl`，可选 `tokenAuthMethod`（`client_secret_basic` 默认 / `client_secret_post`）。只有令牌端点以 400/401 返回 `invalid_grant` / `invalid_client` / `unauthorized_client` 才作废令牌，429、其他 4xx、没有错误码的响应一律按暂时不可用处理、凭据保留。轮换客户端密钥：`PUT .../credentials/org` 传 `{ clientId, clientSecret }`（客户端凭据应用先验证再替换；手填 client 的授权码应用只替换客户端）。授权码应用安装时不 listTools，首个成员经 `POST /orgs/:orgId/apps/:appId/connect` → 授权服务器 → `GET /api/v1/oauth/callback` 连接后用其 token 刷新工具清单。
- **远端报告工具清单变了**（MCP `notifications/tools/list_changed`）→ 调用 `args.onToolsChanged?.()`（可选回调，旧内核不提供，须判空；不等待、出错只记 warn、不影响本次调用）。内核据此投递一次该应用的漂移检查（维护队列，jobId `drift-<appId>-<分钟桶>` 去重）。连接器不要自己重新拉清单。
- **漂移检测在内核**（`packages/kernel/src/tools/drift.ts`，spec 7.3 防 rug-pull / 工具投毒）：每 `tools.driftIntervalHours` 小时（维护队列 job scheduler `drift-scan-interval`）、收到 list_changed、管理员 `POST .../apps/:appId/refresh` 时重新 listTools 并比对快照——新增工具 `pending_review`；定义（spec_hash 或来源）变了 → `pending_review`，新定义存 `pending_spec`、旧定义保留供对比；消失 → `disabled` 并标记 `missing`（又出现按新增处理）。待复核 / 停用的工具不进 `forAgent`。管理员 `POST .../apps/:appId/tools/:name/review {action: "approve" | "reject"}` 复核：approve 采用新定义并启用，默认策略按新注解重新推导（管理员设过的保留，`policySource: "admin"`），reject 停用并保留旧定义。授权按指纹比对，采用新定义后旧授权自然失效。后台检查的凭据：组织凭据；个人凭据型应用依次试至多 3 个现任成员的个人凭据（按凭据最近写入时间倒序），没有则跳过并记日志。审计 `app.tools_drifted`（只有计数）/ `app.tool_reviewed`。
- **预览**（Ruling A20）：`POST /api/v1/orgs/:orgId/apps/preview`（`apps.manage`）请求体同安装（`connector`、`endpoint`、可选 `auth` / `credential` / `name` / `slug`），什么都不写：有 `inspect` 时返回其 `authHints`（映射到内核 AppAuth 形状：`bearer` / `basic` / `api_key{in,name}` / `oauth_client{tokenUrl,scopes}` / `oauth_code{authorizationUrl,tokenUrl,scopes}`）与 `operations`；给了 `auth: none`、或静态认证带凭据、或客户端凭据流带 client 时再 listTools，返回 `tools`（key、默认策略、`issue`）与 `issues`，否则 `tools: null`（授权码流不列，避免动态注册）。外连失败 502 `app.connect_failed`，`ToolError` 的消息（按注入的凭据打码）会带进说明，所以连接器的 ToolError 写成给管理员也看得懂的英文。安装与预览两个路由的请求体上限放宽到 6 MiB（OpenAPI 文档最大 2 MB），其余路由默认 1 MiB。
- 端点里顶层名为 `url` 或 `*Url`（如 `specUrl`、`baseUrl`）的字符串都按 URL 做凭据检查，并对非管理员去掉 query。
- 应用级熔断（连续失败 `tools.breakerFailures` 次后打开 `tools.breakerOpenSeconds` 秒）在内核，连接器只需如实抛错 / 返回。**只有远端不可用才计数**：超时、连接 / 传输错误（非 `ToolError` 的异常，或 `ToolError` 带 `kind: "unavailable"`，如 HTTP 5xx、连不上）；`kind: "error"` 的 `ToolError`（JSON-RPC 业务错误、401 重试后仍失败、重定向、4xx）与 `isError` 结果一样说明远端可达，清零计数。

## 测试

- 插件单测：直接调用处理函数（构造 `ToolCallContext`），见 `plugins/todo/test/todo.test.ts`；多副本读写一致用 `createDualReplicaHarness`。
- 连接器：`@capybara-hq/testing` 的 `startFakeMcpServer({ tools, resources?, requireBearer?, unauthorizedTimes?, intercept?, sseResponses? })` 可模拟慢、报错、401、回显凭据、超大输出、重定向；`sseResponses: true` 时工具处理函数可调第二个参数的 `ctx.notifyToolsChanged()` 在调用途中发 list_changed（`tools` 数组每个请求重新读取，测试里改它即模拟漂移）。漂移检测见 `packages/kernel/test/tools/drift.test.ts`。
- OpenAPI：`startFakeOpenApiServer({ apiKey?, apiKeyIn?, echoKey?, specRedirect?, spec? })`（`/openapi.json` 给出 `defaultFakeOpenApiSpec` 的宠物 CRUD 文档，`/v1/*` 实现它：API key 校验、404 / 500 / 302、纯文本与二进制响应；`setSpec` 模拟文档更新），见 `plugins/connector-openapi/test/` 与 `packages/kernel/test/tools/openapi-e2e.test.ts`。
- OAuth：`startFakeOAuthServer({ dcr?, metadata?, accessTokenTtl?, clients?, tokenDelayMs? })`（自动批准的授权端点、PKCE 校验、refresh 轮换、client_credentials、DCR 开关、`revokeAccessTokens` / `revokeRefreshTokens`），配合 `startFakeMcpServer({ verifyBearer: (t) => as.verify(t), protectedResource: { authorizationServers: [as.issuer], advertise: "header" | "well-known" } })`；内核需 `tools.oauthAllowInsecureLoopback: true` 与 `http.publicUrl`。见 `packages/kernel/test/tools/oauth/`。
- 内核端到端：model-fake 的 `tool:<key>:<json>` 指令让模型调用指定工具（如 `tool:todo__write:{"todos":[]}`），见 `packages/kernel/test/tools/mcp-e2e.test.ts` 与双副本验收 `packages/kernel/test/tools/m3-segment1.dual.test.ts`（审批跨副本、审批超时、杀 worker 后结果未知、插件启用前后）。
