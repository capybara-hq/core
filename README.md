# Capybara

开源的企业级 Agent 平台。内核精简，能力以插件提供。TypeScript / Node 24 / pnpm monorepo，Apache-2.0。

## 快速开始

需要 Node 24、pnpm、Docker、openssl。

```bash
pnpm install
docker compose -f docker/compose.dev.yaml up -d      # postgres:5432 + valkey:6379

export CAPYBARA_DB__URL=postgres://capybara:capybara@localhost:5432/capybara
export CAPYBARA_REDIS__URL=redis://localhost:6379
export CAPYBARA_MASTER_KEY=$(openssl rand -base64 32)
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-example-counter"]'
export CAPYBARA_PLUGIN_CONFIG='{"example-counter":{"step":1}}'   # 可选，step 默认 1

pnpm capybara migrate     # 迁移内核与插件 schema
pnpm capybara start       # 监听 :8080（CAPYBARA_HTTP__PORT 可改）
```

另开一个终端验证：

```bash
curl localhost:8080/healthz
curl -X POST localhost:8080/plugins/example-counter/inc      # {"count":1}
curl localhost:8080/plugins/example-counter/count            # {"count":1}
curl -X POST localhost:8080/plugins/example-counter/inc-later  # 返回 {"jobId":"…"}，约 200ms 后 count 再加 1
```

### 初始化（建首个企业管理员）

全新部署启动后处于未初始化状态（日志里有一条 warn）。用初始化向导建首个企业管理员，可同时建第一个组织：

```bash
curl -s localhost:8080/api/v1/setup                          # {"needsSetup":true}
curl -s -X POST localhost:8080/api/v1/setup \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -c cookies.txt \
  -d '{"login":"admin","password":"change-me-please","displayName":"Admin","orgName":"Research"}'
# 201，返回 account 与 org，并设置会话 Cookie（cap_at / cap_rt）
curl -s localhost:8080/api/v1/me -b cookies.txt               # 当前账号与所属组织
curl -s localhost:8080/api/v1/setup                          # {"needsSetup":false}，再次 POST 返回 409 setup.already_completed
```

- 公开接口的 POST 必须带 `X-Capybara-Csrf: 1` 头。
- 生产部署建议设置 `CAPYBARA_AUTH__SETUP_TOKEN`，初始化时在 body 里带同值的 `setupToken`，避免被抢先初始化。
- 不经 HTTP 也可以用 CLI 建企业管理员（密码只从 stdin 读）：`echo "$PW" | pnpm capybara admin create --login admin --display-name Admin`。
- 用浏览器在非 localhost 的明文 http 上试用时，设 `CAPYBARA_AUTH__COOKIE_SECURE=false`，否则浏览器不保存会话 Cookie；生产保持默认 `true`。

### 在网页上和 agent 对话（不需要模型密钥）

`@capybara-hq/plugin-model-fake` 是确定性脚本化模型，不调用任何外部接口，适合本地试用与演示。沿用上面的数据库、Redis 与主密钥环境变量，换成加载它，再起网页（Next，`apps/web`）：

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake"]'   # 提供模型 model-fake / fake-1
export CAPYBARA_PLUGIN_CONFIG='{}'
export CAPYBARA_HTTP__TRUST_PROXY=1          # 内核只经网页层访问时，信任这一跳代理（见下）
export CAPYBARA_AUTH__COOKIE_SECURE=false    # 本地明文 http 试用
pnpm capybara migrate
pnpm capybara start                          # 内核 :8080
```

另开一个终端：

```bash
pnpm dev:web          # 即 pnpm --filter @capybara-hq/web dev，经 apps/web/server.mjs 启动，监听 :3000
# 内核不在 http://localhost:8080 时设 CAPYBARA_KERNEL_URL；网页端口用 PORT 改
```

浏览器打开 <http://localhost:3000>：初始化向导建管理员与组织 → 新建 agent（模型选 `model-fake/fake-1`）→ 对话。`model-fake` 按消息前缀决定回复：`echo:<文本>` 原样回复，`slow:<毫秒>:<文本>` 逐块慢速流出（方便试「停止」与运行中插话），其他文本回复 `You said: …`。

- **网页层后面的内核要设 `http.trustProxy: 1`**（`CAPYBARA_HTTP__TRUST_PROXY=1`）：`server.mjs` 会丢弃客户端伪造的转发头，把 `x-forwarded-for` 改写为真实对端地址再转给内核，内核信任这一跳才能拿到真实客户端 IP（登录限流按 IP 计数）。网页层必须经 `server.mjs` 启动（`pnpm dev:web` / `pnpm --filter @capybara-hq/web start`），直接 `next dev` / `next start` 不做这一步。
- 内核同时对外直接暴露时不要用跳数，改用受信代理地址列表（如 `CAPYBARA_HTTP__TRUST_PROXY='["10.0.0.0/8"]'`），见 [docs/config.md](docs/config.md)。

接下来可以邀请成员（`POST /api/v1/orgs/:orgId/invitations`）、按角色管理成员（`/api/v1/orgs/:orgId/members`）；内核 API 的写法见 [skills/writing-kernel-api](skills/writing-kernel-api/SKILL.md)。

用完：`docker compose -f docker/compose.dev.yaml down`（加 `-v` 同时清掉数据卷）。

### 模型供应商插件

| 插件 | 说明 |
|---|---|
| `@capybara-hq/plugin-openai-compatible` | **默认发行版自带（M6 起）**。OpenAI 兼容的 Chat Completions 服务（DeepSeek、Qwen、vLLM 等），按端点配置、方言预设差异 |
| `@capybara-hq/plugin-model-fake` | 确定性脚本化模型，用于测试与无密钥演示 |
| `@capybara-hq/plugin-anthropic` | Anthropic（官方 SDK + 原生 Messages API），**按需安装** |
| `@capybara-hq/plugin-openai` | OpenAI（官方 SDK + 原生 Responses API），**按需安装** |

可以同时加载多个，如 `CAPYBARA_PLUGINS='["@capybara-hq/plugin-openai-compatible","@capybara-hq/plugin-anthropic"]'`，`CAPYBARA_PLUGIN_CONFIG` 里按插件名分别给配置。`anthropic` 与 `openai` 不会进默认发行版（M6 起默认镜像只带 openai-compatible；目前还没有发行版，所有插件都要自行安装）：自建部署时先安装对应的包（如 `pnpm add @capybara-hq/plugin-anthropic`），再把它加进 `CAPYBARA_PLUGINS`。

每个模型在插件里声明自己支持的参数（`effort`、`thinking`、`temperature`、`maxOutputTokens` 等标准旋钮，以及 `<插件名>.<名称>` 形式的厂商参数）；网页的 agent 表单按声明渲染，agent 版本保存时按声明校验。

`openai-compatible` 接 DeepSeek 的部署级配置示例（默认示例）：

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-openai-compatible"]'
export CAPYBARA_PLUGIN_CONFIG='{"openai-compatible":{"endpoints":[{"name":"deepseek","baseUrl":"https://api.deepseek.com","dialect":"deepseek","models":[{"id":"deepseek-flash","contextWindow":1048576,"maxOutputTokens":393216,"reasoning":true}]}],"apiKeys":{"deepseek":"sk-..."}}}'
```

- `endpoints`（至少一个）：`name`（端点名，不含 `/`）、`baseUrl`、`dialect`（`generic` / `deepseek` / `qwen`）、`models`（至少一个：`id`、`contextWindow`、`maxOutputTokens`，可选 `reasoning`、`vision`、`caching`、`streamIdleTimeoutMs`）；可选 `midConversationSystem`（覆盖方言默认）。对外模型 id 为 `<端点名>/<模型 id>`，如 `deepseek/deepseek-flash`。上例的 `contextWindow` / `maxOutputTokens` 取自 DeepSeek `GET /models` 对 `deepseek-flash` 的返回；其他模型以其官方返回为准。
- `apiKeys`：端点名 → 密钥，是**顶层**的密钥字段（密钥不能放进 `endpoints[]` 数组元素里）；键必须是已配置的端点名，无密钥的端点（如内网 vLLM）不填。
- 方言：`deepseek` 提供 `thinking`（`on|off`，默认 `on`）与 `effort`（`low|high|max`，默认 `high`），思考内容经 `reasoning_content` 读取并按 DeepSeek 的规则回传；`qwen` 提供 `thinking`（映射为 `enable_thinking`）；`generic` 只提供 `temperature` 与 `maxOutputTokens`。所有方言都声明 `temperature` 与 `maxOutputTokens`；思考相关参数只对配置了 `reasoning: true` 的模型声明。`reasoning` 不写时为 `false`：`deepseek` 方言下这类模型的请求总是发 `thinking: { type: "disabled" }`（DeepSeek 默认开启思考），所以 DeepSeek 的推理模型要显式写 `"reasoning": true`。
- 当前 DeepSeek 模型为 `deepseek-flash` 与 `deepseek-v4-pro`，`deepseek-reasoner` 已下线。
- SDK 不做重试，重试由内核统一处理。

`anthropic` 的部署级配置示例：

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-anthropic"]'
export CAPYBARA_PLUGIN_CONFIG='{"anthropic":{"apiKey":"sk-ant-...","models":["claude-opus-5-5","claude-sonnet-5-5","claude-haiku-5-5"],"serverFallbacks":"default"}}'
# 或逐字段：CAPYBARA_PLUGIN_CONFIG__ANTHROPIC__API_KEY=sk-ant-...
```

- `apiKey`（必填，密钥字段，日志自动打码）；`baseUrl`（可选，网关或测试夹具地址）。
- `models`：允许的模型 id，默认 `["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]`；模型信息经 Models API 获取并在 kv 缓存 1 小时。
- `serverFallbacks`：`default`（默认）时，对 Claude Opus 5.5 / Opus 5 / Fable 5.1 / Sonnet 5.5 开启服务端拒答兜底（beta `server-side-fallback-2026-07-01`，仅 Claude API）；`off` 关闭。
- SDK 不做重试（`maxRetries: 0`），重试由内核统一处理。

`openai` 的部署级配置示例（OpenAI 的模型接口不返回上下文窗口等信息，所以模型清单由配置给出）：

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-openai"]'
export CAPYBARA_PLUGIN_CONFIG='{"openai":{"apiKey":"sk-...","models":[{"id":"gpt-5.5","contextWindow":400000,"maxOutputTokens":128000,"reasoning":true,"vision":true}]}}'
```

- `apiKey`（必填，密钥字段）；`baseUrl`、`organization`（可选）。
- `models`（至少一个）：`id`、`contextWindow`、`maxOutputTokens`、`reasoning`、`vision`，可选 `streamIdleTimeoutMs`（推理模型长时间无输出时的看门狗阈值）、`effortLevels`（该模型接受的 effort 档位，取自 `low|medium|high|xhigh|max`，按给定顺序声明；未给时为 `low|medium|high`，所有推理模型都接受；档位因模型而异，例如 gpt-5-nano 不接受 `max`）。
- `reasoningSummary`：`auto`（默认）请求推理摘要，agent 可用 thinking 参数关闭；未完成组织验证的账号请求摘要会被拒绝，此时设 `off`，模型也不再声明 thinking 参数。
- 以 `store: false` 调用，推理项以加密内容原样回放；SDK 同样不做重试。

真实接口的一致性测试默认跳过，设了环境变量才跑：anthropic 用 `CAPYBARA_TEST_ANTHROPIC_API_KEY`；openai 用 `CAPYBARA_TEST_OPENAI_API_KEY` 与 `CAPYBARA_TEST_OPENAI_MODEL`；openai-compatible 用 `CAPYBARA_TEST_OAICOMPAT_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIALECT`（四个都设才跑）。

写模型供应商插件见 [skills/writing-model-providers](skills/writing-model-providers/SKILL.md)。

`example-counter` 是写插件的参考实现；写自己的插件见 [skills/writing-plugins](skills/writing-plugins/SKILL.md)，配置项清单见 [docs/config.md](docs/config.md)。

### 工具与应用（MCP / OpenAPI）

agent 经「工具」做事。工具有三个来源：内置（`ask_user`、`read_tool_output`，工具多时自动加入 `tool_search`）、插件（如 `@capybara-hq/plugin-todo` 的任务清单工具）、**应用**（把远端 MCP 服务或 OpenAPI 描述的 HTTP API 接进组织）。写操作默认触发审批，确认前 run 暂停，不占会话锁。

加载连接器插件（部署级，不需要按组织启用）：

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-connector-mcp","@capybara-hq/plugin-connector-openapi","@capybara-hq/plugin-todo"]'
# 生产只接受 https 端点；本机联调才打开 allowInsecureLoopback（明文 http 的 127.0.0.1 / localhost / [::1]）
export CAPYBARA_PLUGIN_CONFIG='{"connector-mcp":{"allowInsecureLoopback":true},"connector-openapi":{"allowInsecureLoopback":true}}'
```

**网页向导**（组织管理员）：登录后打开「应用」→「安装」（`/apps/install`）：选端点类型（MCP 服务 / OpenAPI 文档）→ 填端点（OpenAPI 可给文档 URL 或上传 JSON / YAML，最大 2 MB；`baseUrl` 可覆盖文档里的 servers）→ 选认证（OpenAPI 会按文档声明的 `securitySchemes` 预填，并列出操作供勾选）→ 预览工具与默认策略 → 安装。安装后的应用详情页可调整每个工具的启停与默认策略，并复核漂移（见下）。在 agent 表单里选上该应用的工具，agent 才会用到它。

**API**（用管理员的会话 Cookie 或令牌；写请求带 `X-Capybara-Csrf: 1`）：

```bash
# 安装一个 MCP 应用（静态 Bearer，组织共用一个凭据）
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/apps -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"name":"Docs","slug":"docs","connector":"mcp",
       "endpoint":{"url":"https://mcp.example.com/mcp"},
       "auth":{"type":"bearer","ownership":"org"},
       "credential":{"token":"<token>"}}'

# 安装一个 OpenAPI 应用（API key 放 header；operations 缺省 = 全部操作）
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/apps -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"name":"Petstore","slug":"pets","connector":"openapi",
       "endpoint":{"specUrl":"https://api.example.com/openapi.json","operations":["listPets","getPet"]},
       "auth":{"type":"api_key","ownership":"org","in":"header","name":"X-Api-Key"},
       "credential":{"token":"<key>"}}'

# 预览（什么都不写）：返回文档声明的认证方式、操作清单和工具预览
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/apps/preview -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"connector":"openapi","endpoint":{"specUrl":"https://api.example.com/openapi.json"}}'
```

应用工具在模型面前的名字是 `<slug>__<工具名>`（如 `docs__search`）。agent 定义里按引用选工具：`"tools":[{"kind":"app","appId":"<id>","tools":"all"}]`（`"all"` = 该应用当前所有启用的工具，也可给工具名数组）。

**认证方式**（`auth.type`；`ownership` 为 `org` 时全组织共用一个凭据，为 `personal` 时每位成员各自连接，在「设置 → 个人连接」里填写或授权）：

| `auth.type` | 说明 | 凭据 |
|---|---|---|
| `none` | 无需认证 | — |
| `bearer` / `basic` / `api_key{in,name}` / `headers{names}` | 静态凭据，加密存储，只在请求时注入 | `credential`：`{token}` / `{username,password}` / `{headers:{…}}`；安装后用 `PUT .../apps/:appId/credentials/org` 轮换（个人凭据用 `.../credentials/me`） |
| `oauth_code`（个人） | 授权码 + PKCE：每位成员点「连接」跳转授权服务器登录；`discovery: "mcp"` 自动发现授权服务器，`client: "dcr"` 安装时自动注册客户端 | 授权服务器不支持 DCR 时改用 `client: "manual"`，安装时给 `credential: {clientId, clientSecret?}`；也可 `discovery: "manual"` 并给 `authorizationUrl` / `tokenUrl` |
| `oauth_client`（组织） | 客户端凭据流：组织共用一个 OAuth 客户端换令牌，安装时先验证 | `credential: {clientId, clientSecret}`，轮换用 `PUT .../credentials/org` |

- **OAuth 需要 `http.publicUrl`**（`CAPYBARA_HTTP__PUBLIC_URL`）：填**网页（`apps/web`）的外部可达源**，如 `https://capybara.example.com`，而不是内核自己的地址。回调地址是 `<publicUrl>/api/v1/oauth/callback`，须登记到授权服务器；它经网页的 `/api` 代理转给内核——发起连接时的绑定 cookie 也是经这个代理设在网页源上的，回调完成后再跳回 `<publicUrl>` 下的网页页面，所以三者必须同源。没配时安装 OAuth 应用会被拒绝。令牌在过期前由内核自动刷新，刷新被拒则凭据作废，成员会在对话里看到「需要连接」卡片。
- 凭据不进事件日志、模型上下文与审计；工具结果与错误里出现的凭据值会被内核打码。端点的固定头与 URL query 里不能放凭据。

**审批与收件箱**：策略（`allow` / `ask` / `deny`）默认按工具注解推导（只读 → `allow`，其余 → `ask`），管理员可逐工具改，agent 还可以把某个工具收紧。`ask` 的调用在对话里出审批卡片，也汇总在网页的「收件箱」（`/inbox`）；批准时可选「仅这次 / 本会话 / 以后都允许」，「以后都允许」的授权在「设置 → 授权」里查看与撤销，工具定义一变即失效。审批超过 `tools.approvalTimeoutHours`（默认 24）按拒绝处理；agent 自己不能审批。远端工具在调用途中向用户要输入（MCP elicitation）时，对话里出输入卡片。API：`/api/v1/orgs/:orgId/approvals`、`/questions`、`/me/tool-grants`。

**工具定义漂移**：内核每 `tools.driftIntervalHours` 小时（默认 24）、收到远端的 `list_changed` 通知、管理员点「刷新」时重新读取应用的工具清单。新增或定义有任何变化的工具先进入「待复核」，复核（批准 / 拒绝）前模型用不到，防止远端偷偷改工具描述。

**`tool_search`**：agent 可用工具超过 `tools.searchThresholdTools`（30）个或估算超过 `tools.searchThresholdTokens`（8000）token 时，不再把全部定义塞进每次请求，而是给一份工具目录，模型用 `tool_search` 按关键词加载需要的。组织管理员可在「设置 → 组织」关闭（`PATCH /api/v1/orgs/:orgId/settings {"toolSearch":"off"}`）。

**插件工具要先在组织启用**：插件工具（如 `todo__write`）只在启用了该插件的组织可用（应用不需要）。组织管理员：

```bash
curl -s -X PUT localhost:8080/api/v1/orgs/$ORG/plugins/todo -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' -d '{"enabled":true}'
```

写工具见 [skills/writing-tools](skills/writing-tools/SKILL.md)，写连接器见 [skills/writing-connectors](skills/writing-connectors/SKILL.md)，相关配置（`tools.*`、`http.publicUrl`）见 [docs/config.md](docs/config.md)。

## 运维须知

- **初始化向导何时重新开放**：「需要初始化」的判定是「不存在活跃（`status = active`）的企业管理员」，每次实时查 PG。如果有人直接改库把所有企业管理员都停用或撤销了，部署会重新对未认证的 `POST /api/v1/setup` 开放，谁先调用谁就成为新的企业管理员。生产部署请始终设置 `CAPYBARA_AUTH__SETUP_TOKEN`（初始化须带同值的 `setupToken`）；恢复管理员优先用 CLI：`echo "$PW" | pnpm capybara admin create --login <名字> --display-name <显示名>`。
- **停机时间预算**：收到 SIGTERM / SIGINT 后总共最多 30 秒，按阶段依次等待：中止进行中的内核迁移 2s → HTTP（等监听完成并关闭连接，到点强制断开）10s → 运行（本进程的 agent 运行在下一个步骤边界停下、任务回到队列，超时的由其他副本按 stalled 机制续跑）10s → 插件（含插件队列排空）5s。每个阶段实际等待 `min(阶段预算, 总剩余)`；前面各阶段都用满时，最后只剩约 3 秒给 bus 订阅连接、Redis 与 PG 连接池收尾，这三步共享余下的时间，超时只记 warn、不再等待（PG 连接池的销毁可能在 `stop()` 返回之后才完成）。编排系统的终止宽限期（如 Kubernetes `terminationGracePeriodSeconds`）应不少于 30 秒。

## 开发

```bash
pnpm lint && pnpm typecheck && pnpm check && pnpm test   # 测试需要 Docker（Testcontainers）
```

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，面向 Agent 的仓库说明见 [AGENTS.md](AGENTS.md)。

## 许可证

[Apache-2.0](LICENSE)
