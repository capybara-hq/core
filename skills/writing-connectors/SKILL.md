---
name: writing-connectors
description: 新建或修改连接器插件时使用（provides connector@1，如 plugins/connector-mcp、plugins/connector-openapi）：endpointSchema、按次 open / 关闭的会话生命周期、每个请求前 auth() 与 onUnauthorized 重试一次、不跟随重定向与 https（allowInsecureLoopback）、ToolError 的 kind 与熔断、connectorData 与按已复核定义路由（ctx.spec）、inspect 与安装预览、onToolsChanged、onElicit 与 elicitation 续跑、resources / prompts 可选方法、打码是内核的事，以及用 startFakeMcpServer / startFakeOpenApiServer / startFakeOAuthServer 写测试。
---

# 写连接器

连接器把一类远端服务接成组织里的「应用」（MCP 服务、OpenAPI 描述的 HTTP API 等）：插件 `provides: [CONNECTOR_CAPABILITY]`，`setup` 里 `ctx.provide(CONNECTOR_CAPABILITY, connector)`。通用的插件写法（清单、配置、多副本禁令）见 `skills/writing-plugins`，工具的通用规则（命名、英文描述与错误、策略、审批）见 `skills/writing-tools`，这里只讲连接器特有的部分。

参考实现：`plugins/connector-mcp`（Streamable HTTP 的 MCP 服务，含 elicitation、prompts、resources、list_changed）与 `plugins/connector-openapi`（OpenAPI 3.0 / 3.1，每个 operation 一个工具，实现了 `inspect`、`connectorData` 路由）。契约在 `packages/plugin-sdk/src/connector.ts`。

两个官方连接器的部署级配置都只有 `allowInsecureLoopback`（默认 `false`，仅开发 / 测试允许 `127.0.0.1` / `localhost` / `[::1]` 的明文 http）；`CAPYBARA_PLUGIN_CONFIG` 里按插件名给，如 `{"connector-mcp":{"allowInsecureLoopback":true}}`。连接器是部署级的，不需要按组织启用。

## 契约

```ts
interface Connector {
  kind: string;                 // 存进 apps.connector，如 "mcp"、"openapi"
  endpointSchema: ZodTypeAny;   // 应用 endpoint 的校验（安装 / 预览时内核调用）
  open(args: ConnectorOpenArgs): Promise<ConnectorSession>;
  inspect?(args: { endpoint; signal }): Promise<{ authHints: AuthHint[]; operations?: ConnectorOperation[] }>;
}
interface ConnectorOpenArgs {
  endpoint: unknown;                        // 已按 endpointSchema 校验
  auth(): Promise<AuthInjection>;           // { headers, query? }
  onUnauthorized(): Promise<void>;
  signal: AbortSignal;
  onToolsChanged?(): void;                  // 可选
  onElicit?(req: ElicitationRequest): Promise<ElicitationResponse>;   // 可选
}
interface ConnectorSession {
  listTools(): Promise<ToolSpec[]>;
  callTool(name, input, signal, ctx?: { spec: ToolSpec }): Promise<ToolResult>;
  listResources?(); readResource?(uri);     // 可选
  listPrompts?(); getPrompt?(name, args);   // 可选
  close(): Promise<void>;
}
```

可选的回调与方法都要判空：旧内核不提供回调，连接器不支持的能力就不实现对应方法。

## `endpointSchema`

- 内核在安装 / 预览 / 创建时用它校验 `endpoint`（失败 → 400 `validation_failed`），`open` 收到的是已校验的值（连接器里仍 `schema.parse` 一次拿类型）。
- URL 只接受 https；部署配置 `allowInsecureLoopback` 打开时才放行确切的本机 http 三个主机名（`localhost.evil.com` 之类不算）。校验消息写英文并说明规则。
- 端点配置对组织成员可见，**不得放凭据**：固定头禁止 `Authorization` / `Cookie` 等凭据头（凭据走应用认证设置、加密存储）；内核在安装时再按头名 / query 名 / URL 用户信息做一道检查并 400 拒绝（`x-api-key`、`*-token`、`*-secret`、`key` / `token` / `access_token` 等 query）。顶层名为 `url` 或 `*Url` 的字符串字段都按 URL 做凭据检查；没有 `apps.manage` 的人读应用时只看到不带 query 的 URL 与头名。
- 体积大的字段（如 OpenAPI 的 `specText`，≤ 2 MB）：应用列表 / 详情不回显 `text` / `*Text` 字段全文，只给 `<field>Bytes` 与 `<field>Sha256`；安装与预览两个路由的请求体上限放宽到 6 MiB，其余路由 1 MiB。

## 会话生命周期：按次打开

内核每次 `listTools`（安装 / 刷新 / 漂移检查）、每次工具调用、每次读资源或提示都 `open` → 用 → `close`。连接器**不缓存连接、不持有进程内会话**（多副本下下一次调用可能在另一个副本，进程内状态一律不行）。`close` 尽快返回：内核最多等 5 秒，出错只记 warn，不影响结果。尊重 `signal`（`open` 的与 `callTool` 的）；超时由内核的 `tools.timeoutMs` 决定，SDK 自带的请求超时要设得足够长，不要抢在内核前面。

## 出站请求的规矩

- **每个请求前调用 `auth()`**，把返回的 `headers` / `query` 合并进请求，不要在会话开头取一次就一直用（凭据可能刷新）。凭据由内核解密并只在这一刻出现，连接器不存、不记日志、不回显。
- **401 → `onUnauthorized()` 一次，用新的 `auth()` 重试一次**；仍 401 抛 `ToolError("Authentication failed for this app; ask the user to reconnect it.")`。不要循环；其他错误也不要在插件里重试，重试与熔断由内核管。
- **不跟随重定向**（`fetch(…, { redirect: "manual" })`，3xx 一律报错）：跟随会把请求体与注入的凭据头带到别的源。取远端描述文档（OpenAPI 的 `specUrl`）也不带凭据、也不跟随重定向。
- 非 https（本机 loopback 例外）的任何出站地址一律拒绝，包括文档里声明的 server 地址。
- 远端内容不受信任：远端描述里的 `inputSchema` 由内核在校验前清洗（去掉 `pattern` / `patternProperties` / `format`，超过 64 KB 或嵌套超过 32 层的不校验，每个 schema 独立的 Ajv 实例）；连接器自己也限制响应体大小与读取时长（openapi：文档 2 MB / 30 秒，响应正文 5 MB）。

## `ToolError`、`kind` 与熔断

- 抛 `ToolError(message)`：message **原样**给模型，必须英文、可执行（含 `use` / `call` / `retry` / `check` / `ask` / `pass` / `provide` 之一，`pnpm check` 的 `tool-error-actionable` 检查）。预览 / 安装失败时同一条消息（按注入的凭据打码）会带进 502 `app.connect_failed` 的说明，所以写得让管理员也看得懂。
- `new ToolError(message, { kind: "unavailable" })` 表示**远端不可用**（连不上、HTTP 5xx）：计入应用熔断。缺省 `kind: "error"`（参数错误、业务错误、401 重试后仍失败、重定向、4xx、JSON-RPC 业务错误）说明远端可达，与 `isError` 结果一样清零计数。
- 熔断在内核（连续失败 `tools.breakerFailures` 次后打开 `tools.breakerOpenSeconds` 秒），只有超时、传输 / 连接错误（非 `ToolError` 的异常）与 `kind: "unavailable"` 计数。连接器如实抛错 / 返回即可。
- 抛其他异常：模型只看到 `Tool <key> failed (<ErrorName>)…`，详情进经打码的日志。上游 HTTP 错误给模型只说状态码，正文截断后记 warn。
- 结果的 `isError: true` 表示「调用成功但内容是错误」（如 MCP 的 `isError`、OpenAPI 的非 2xx 正文）。

## `listTools`、`connectorData` 与按已复核的定义路由

- 映射远端工具清单时保留 `annotations`（内核据此推导默认策略：`readOnlyHint` → allow，其余 ask），缺描述用 title / name 兜底并 warn。应用工具的 key 是 `<appSlug>__<tool>`，整体须匹配 `^[a-zA-Z0-9_-]{1,64}$`（见 `skills/writing-tools`）；超长 / 含非法字符时内核不截断、不猜，停用该工具并在 `issues` 里写原因。工具名由连接器给出：把远端名字规整到合理长度并保证同一应用内不重复（openapi 把 operationId 里的非法字符换成下划线、截到 40 字符，重名在预览里报告）。
- **`ToolSpec.connectorData`**（Ruling A21，安全）：调用所需的路由信息放在这个不透明、可 JSON 序列化的字段里（OpenAPI：方法、路径模板、参数位置 / 风格、请求体媒体类型、解析好的服务器地址）。内核存进快照并计入 `spec_hash`（变了即漂移、待复核），**从不发给模型**。
- 调用时内核把该工具**已复核**的定义（`app_tools.spec`，不是待复核的 `pending_spec`）作为 `callTool` 的第 4 个参数 `ctx.spec` 交回。远端描述可能被改（rug-pull），所以按 `ctx.spec` 路由，**不要重新读取远端描述**；`ctx` 缺失（旧内核）时报错提示管理员刷新。MCP 这种由远端按名字路由的连接器可忽略 `ctx`。
- 远端描述改了怎么办不是连接器的事：内核定时（`tools.driftIntervalHours`）、收到 `onToolsChanged`、管理员刷新时重新 `listTools` 比对快照，新增或变化的工具待复核，复核前不可用（见 `skills/writing-tools` 的漂移一节）。所以 `listTools` 的输出应**确定性**：同一份远端描述每次给出同样的 spec（字段顺序稳定、不带时间戳 / 随机值），否则会反复触发复核。

## `inspect` 与安装预览（Ruling A20）

`inspect({ endpoint, signal })` 不带凭据读端点的描述，返回 `authHints`（远端声明的认证方式，映射到内核 AppAuth 的形状：`bearer` / `basic` / `api_key{in,name}` / `oauth_client{tokenUrl,scopes}` / `oauth_code{authorizationUrl,tokenUrl,scopes}`，带 `scheme` 名与可选 `description`；只列内核支持的方式）与可选的 `operations`（`id` 是端点里勾选用的 id，`method` 大写、`path`、`summary?`）。失败抛英文的 `ToolError`。

内核的 `POST /api/v1/orgs/:orgId/apps/preview`（`apps.manage`，什么都不写）与网页安装向导据此工作：有 `inspect` 时返回 `authHints` / `operations`；给了 `auth: none`、或静态认证带凭据、或客户端凭据流带 client 时再 `listTools` 返回 `tools`（key、默认策略、`issue`）与 `issues`，否则 `tools: null`（授权码流不列，避免动态注册）。不需要预填的连接器（如 MCP）不实现 `inspect`，内核判空。

## `onToolsChanged`

远端报告工具清单变了（MCP `notifications/tools/list_changed`）→ 调用 `args.onToolsChanged?.()`：不等待、出错只记 warn、不影响本次调用，可能多次调用。内核据此投递一次该应用的漂移检查（维护队列，jobId `drift-<appId>-<分钟桶>` 去重）。连接器不要自己重新拉清单。

## `onElicit`：远端在调用途中向用户要输入

MCP `elicitation/create`（表单与 URL 两种模式）→ 调用 `args.onElicit?.(request)`，把返回的 `ElicitationResponse` 原样回给远端。**内核没提供 `onElicit` 时不要声明 elicitation 能力**（远端便不会发起）。URL 模式也可能以错误 `-32042`（URL elicitation required）出现：逐个交给 `onElicit`，全部 `accept` 后重试一次调用。

**连接器不要等用户、不要缓存答案**。内核不能在等人期间保持远端调用（run 暂停、会话关闭），所以需要问用户时它会中止 `callTool` 的 signal，并让 `onElicit` 以错误拒绝——连接器让该错误原样结束这次调用。内核把请求转成通用输入请求（`packages/kernel/src/tools/elicitation.ts`：表单按 InputForm 子集映射 `requestedSchema`，URL 模式为带 `url` 的表单 + 「已完成」开关），用户回答后用**同一 input 重新发起调用**；远端再次发起**同样的** elicitation（表单按 `requestedSchema` + 文案、URL 按 origin + path + 文案匹配）时，`onElicit` 立即用答案答复。

限制（Ruling A24，已接受）：远端第二次不再问 / 换了 schema 时答案用不上（后者会再问一次，至多 3 轮）；elicitation 之前的副作用会随重新发起的调用再做一次；URL 完成通知（`notifications/elicitation/complete`）收不到，以用户确认为准；超出子集的表单立即 `decline`，工具结果后附英文说明。

## 可选：resources 与 prompts

- 会话实现了 `listResources` / `readResource` 时内核补 `<slug>__list_resources` / `<slug>__read_resource` 两个工具（均标 `readOnlyHint`，默认 allow；管理员可停用），并支持网页输入框的 `@` 引用（消息接口 `attachments: [{ appId, uri }]`，内核以发送者凭据读取、打码、限长，作为用户消息的附加文本块）。资源读取（列表与附件）遵守管理员对该应用 `read_resource` 工具的启停（Ruling A23：停用 → 不列出、附件 409 `app.resources_disabled`）。
- 实现了 `listPrompts` / `getPrompt` 时内核提供 `GET /orgs/:orgId/apps/prompts`、`POST /orgs/:orgId/apps/:appId/prompts/:name`，网页输入框出现 `/应用:提示名` 斜杠命令。`getPrompt` 失败抛英文 `ToolError`、不含凭据。
- 这两类都由用户本人发起、用其凭据，不经工具策略。代码见 `packages/kernel/src/tools/app-content.ts`。

## OAuth 与凭据：全在内核

连接器只需照上面「每个请求前 `auth()`、401 调一次 `onUnauthorized()`」做，OAuth 本身（`packages/kernel/src/tools/oauth/`）不在连接器里：

- `auth()` 返回的 Bearer 由内核在过期前 60 秒刷新；`onUnauthorized()` 在 Redis 锁 `capk:oauth-refresh:<orgId>:<appId>:<owner>` 内强制刷新（别的副本已刷新则直接用新 token，不并发刷新）；refresh 被拒 → 凭据删除、调用得到「需要连接」。
- 认证方式 `oauth_code`（个人；`discovery: "mcp"` 走 RFC 9728 → RFC 8414 发现，`discovery: "manual"` 给 `authorizationUrl` / `tokenUrl`；`client: "dcr"` 安装时 RFC 7591 注册，授权服务器不支持 DCR → 502 `app.connect_failed` 带 `dcr_unsupported`，改用 `client: "manual"` + `credential: { clientId, clientSecret? }`）与 `oauth_client`（组织，客户端凭据流）。都要求配置 `http.publicUrl`；可选 `tokenAuthMethod`（`client_secret_basic` 默认 / `client_secret_post`）。
- 只有令牌端点以 400 / 401 返回 `invalid_grant` / `invalid_client` / `unauthorized_client` 才作废令牌；429、其他 4xx、没有错误码的响应一律按暂时不可用处理、凭据保留。
- 授权码应用安装时不 `listTools`（首个成员经 `POST /orgs/:orgId/apps/:appId/connect` → 授权服务器 → `GET /api/v1/oauth/callback` 连接后，用其 token 刷新工具清单）。轮换客户端密钥：`PUT .../credentials/org` 传 `{ clientId, clientSecret }`。

## 打码是内核的事

内核写事件 / 存档之前，用本次调用**实际注入的凭据值**给应用工具的结果与错误打码（`[REDACTED]`），日志也经打码。但连接器仍不得主动把凭据写进错误消息、日志或工具结果：**不回显请求头**、不把含凭据的 URL 放进错误里、不 `JSON.stringify` 整个请求。测试里用「回显凭据」的夹具（`echoKey`、`intercept`）确认没有漏。

## 测试

均来自 `@capybara-hq/testing`（连接器插件作 devDependency）：

- `startFakeMcpServer({ tools, resources?, prompts?, sessions?, requireBearer?, verifyBearer?, protectedResource?, unauthorizedTimes?, onCall?, intercept?, sseResponses? })`：模拟慢、报错、401、回显凭据（`calls[].headers`）、超大输出、重定向；`tools` 数组每个请求重新读取，测试里改它即模拟漂移；`sseResponses: true` 时处理函数可调 `ctx.notifyToolsChanged()` 在调用途中发 list_changed；`sessions: true`（有状态会话）时可调 `ctx.elicit(params)` 发起 elicitation（记录在 `server.elicitations`）。
- `startFakeOpenApiServer({ apiKey?, apiKeyIn?, echoKey?, specRedirect?, spec? })`：`/openapi.json` 给出 `defaultFakeOpenApiSpec` 的宠物 CRUD 文档，`/v1/*` 实现它（API key 校验、404 / 500 / 302、纯文本与二进制响应）；`setSpec` 模拟文档更新。
- `startFakeOAuthServer({ dcr?, metadata?, accessTokenTtl?, clients?, tokenDelayMs? })`：自动批准的授权端点、PKCE 校验、refresh 轮换、client_credentials、DCR 开关、`revokeAccessTokens` / `revokeRefreshTokens`；配合 `startFakeMcpServer({ verifyBearer: (t) => as.verify(t), protectedResource: { authorizationServers: [as.issuer], advertise: "header" | "well-known" } })`；内核需 `tools.oauthAllowInsecureLoopback: true` 与 `http.publicUrl`。

测试清单（照 `plugins/connector-mcp/test/` 与 `plugins/connector-openapi/test/`）：endpoint 校验（非 https、凭据头）、每个请求前取 `auth()`、401 重试一次且仅一次、重定向被拒、`ToolError` 的 `kind`、凭据不进错误、`close` 后无残留连接、`signal` 中止；有 `connectorData` 的连接器再测「描述变了仍按 `ctx.spec` 调用」。内核端到端见 `packages/kernel/test/tools/mcp-e2e.test.ts`、`openapi-e2e.test.ts`、`drift.test.ts`、`oauth/`。

真实服务验收在 `packages/kernel/test/tools/m3-live.test.ts`（DeepWiki MCP、Petstore OpenAPI、GitHub MCP）：只在显式设置 `CAPYBARA_TEST_LIVE_TOOLS=1` 时运行（普通 `pnpm test` 不访问外网）；GitHub 另需 `CAPYBARA_TEST_GITHUB_MCP_TOKEN` 与 `CAPYBARA_TEST_GITHUB_REPO`（owner/name），会开一个 issue 并在 `finally` 里经 GitHub REST 关闭。改了连接器的出站请求或协议处理后，本地用 `CAPYBARA_TEST_LIVE_TOOLS=1 pnpm vitest run packages/kernel/test/tools/m3-live.test.ts -t live` 跑一遍。
