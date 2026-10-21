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
export CAPYBARA_PLUGIN_PERMISSIONS__AUTO_APPROVE=true   # 仅本地试用：自动批准插件权限（生产保持关闭）

pnpm capybara migrate     # 迁移内核与插件 schema
pnpm capybara start       # 监听 :8080（CAPYBARA_HTTP__PORT 可改）
```

插件权限：插件首次出现、或升级后清单比已批准的权限多出任何一项时**不加载**（启动日志有 warn），依赖它的插件同样不加载；
权限变少或不变直接加载。生产不要开 `autoApprove`，改用 CLI 审阅并批准（直连 PG，会先执行内核迁移），批准后重启内核生效：

```bash
pnpm capybara plugins review                    # 列出待批准插件与新增的权限项
pnpm capybara plugins approve example-counter   # 终端确认后写入快照并记审计；--yes 跳过确认
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

- `endpoints`（至少一个）：`name`（端点名，不含 `/`）、`baseUrl`、`dialect`（`generic` / `deepseek` / `qwen` / `ark`；方舟 baseUrl 为 `https://ark.cn-beijing.volces.com/api/v3`）、`models`（至少一个：`id`、`contextWindow`、`maxOutputTokens`，可选 `reasoning`、`vision`、`caching`、`streamIdleTimeoutMs`）；可选 `midConversationSystem`（覆盖方言默认）。对外模型 id 为 `<端点名>/<模型 id>`，如 `deepseek/deepseek-flash`。上例的 `contextWindow` / `maxOutputTokens` 取自 DeepSeek `GET /models` 对 `deepseek-flash` 的返回；其他模型以其官方返回为准。
- `apiKeys`：端点名 → 密钥，是**顶层**的密钥字段（密钥不能放进 `endpoints[]` 数组元素里）；键必须是已配置的端点名，无密钥的端点（如内网 vLLM）不填。
- 方言：`deepseek` 提供 `thinking`（`on|off`，默认 `on`）与 `effort`（`low|high|max`，默认 `high`），思考内容经 `reasoning_content` 读取并按 DeepSeek 的规则回传；`qwen` 提供 `thinking`（映射为 `enable_thinking`）；`ark` 提供 `thinking`（映射为 `thinking.type`，无默认值，不回传思考）；`generic` 只提供 `temperature` 与 `maxOutputTokens`。所有方言都声明 `temperature` 与 `maxOutputTokens`；思考相关参数只对配置了 `reasoning: true` 的模型声明。`reasoning` 不写时为 `false`：`deepseek` 方言下这类模型的请求总是发 `thinking: { type: "disabled" }`（DeepSeek 默认开启思考），所以 DeepSeek 的推理模型要显式写 `"reasoning": true`。
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

### 接入 Slack 与 Lark（机器人、登录、通讯录）

`@capybara-hq/plugin-slack` 与 `@capybara-hq/plugin-lark` 各提供三种能力：IM 机器人（`channel@1`，在 IM 里和 agent 对话、点卡片审批）、网页登录（`identity-source@1`）、通讯录同步（`directory@1`）。三处用同一个身份键（`slack:<team id>` / `lark:<tenant_key>` + 平台用户 id），同一个人只对应一个账号。两者都走长连接（Slack Socket Mode、Lark 长连接），**不需要公网回调地址**。平台侧的每一步、需要的权限（scope）与行为细节见插件 README，这里只列顺序：

- Slack：[plugins/slack/README.md](plugins/slack/README.md)
- Lark：[plugins/lark/README.md](plugins/lark/README.md)

**0. 前提**：配置 `http.publicUrl`（网页的外部可达源，同上文 OAuth 一节）。绑定链接、卡片里的网页链接、登录回调都基于它；没配时机器人认不出未绑定的人（只回「请联系管理员」），审批 / 提问卡片退化为一句「请到网页上处理」，第三方登录不可用。长连接只在 `worker` 角色的副本上运行（`capybara start` 默认全部角色）。

**1. 建平台应用**
- Slack：用 [`plugins/slack/app-manifest.yaml`](plugins/slack/app-manifest.yaml) 从 manifest 建应用（Socket Mode、事件订阅与 bot scope 都在里面），再生成应用级令牌 `xapp-…`（scope `connections:write`）、安装到工作区得到 `xoxb-…`。
- Lark：建**企业自建应用**（长连接只支持自建应用），加机器人能力，开通 README 列出的权限，事件与回调都选「使用长连接」，发布版本并设置可用范围。**登录、机器人、通讯录必须用同一个 Lark 应用**：`open_id` 按应用区分，换个应用同一个人就对不上（插件会尽量核对并报错）。目前只支持 Lark 国际版（`open.larksuite.com`），飞书（`feishu`）区域已预留、暂不可用。

**2. 装插件并批准权限**：安装包并加进 `CAPYBARA_PLUGINS`（如 `'["@capybara-hq/plugin-openai-compatible","@capybara-hq/plugin-slack","@capybara-hq/plugin-lark"]'`）。新插件首次出现时不加载，用 `pnpm capybara plugins review` 查看它要的权限（两个插件只声明了 `permissions.network`，并提供三种能力、带部署级与组织级配置），`pnpm capybara plugins approve slack` / `approve lark` 批准后重启。`pluginPermissions.autoApprove` 只用于本地开发与试用。

**3. 组织启用并建渠道连接**（组织管理员，网页）：「设置 → 插件」启用 `slack` / `lark`（可在这里同时填通讯录的组织级配置，见第 5 步）→ 一级导航「渠道」→ 新建连接：选插件，填 bot 凭据（Slack `appToken` + `botToken`；Lark `appId` + `appSecret`，都进密钥存储、接口只回「已设置」），选绑定的 agent 与未绑定用户的处理方式：
- `bind`（默认）：不认识的人私聊机器人会收到绑定卡片，点开网页登录后确认绑定；在群里只提示他去私聊（绑定链接不发在群里）。
- `anonymous`：本组织租户里未绑定的人以该组织的「匿名访客」身份对话，只在绑定的 agent 对全组织可见时生效，不能用个人凭据；外部租户的人仍只能绑定。

保存时插件会校验凭据（`verify`），随后某个 worker 副本建立长连接；连接页显示状态与最近一次错误（`last_error`）。IM 里机器人固定话术的语言取「设置 → 组织 → IM 语言」（zh / en，默认 en）。

**4. 网页登录**（企业管理员，部署级）：
- 在平台应用里登记回调地址 `<http.publicUrl>/api/v1/auth/sso/slack/callback` / `.../sso/lark/callback`；
- 部署级配置写 `pluginConfig.slack.clientId` / `clientSecret`、`pluginConfig.lark.appId` / `appSecret`（密钥字段日志打码）；
- 把插件名加进 `auth.loginSources`（如 `CAPYBARA_AUTH__LOGIN_SOURCES='["slack","lark"]'`，热更新），登录页出现「使用 Slack / Lark 登录」。

第三方登录只建账号、不加入任何组织（成员关系来自邀请或通讯录同步）。要让第三方登录按**已验证邮箱**合并到既有本地账号，把你们企业控制的租户写进 `auth.trustedIdentitySources`，每项是完整键 `<插件>:<租户 id>`（如 `"slack:T0123ABCD"`；只写插件名会被拒绝）。只列你们自己的工作区 / 租户，否则那个租户里的任何人都能认领你们用户的邮箱。目前只有 Slack 登录会给出「邮箱已验证」，Lark 登录与两家的通讯录一律报未验证，所以 Lark 登录不会合并账号。

**5. 通讯录**（组织管理员）：在「设置 → 插件」该插件的组织级配置里填 Slack `teamId`（`T…`）+ `botToken`，或 Lark `appId` + `appSecret`（Lark 还要把通讯录权限范围设为全部成员）。不填就视为「未配置」，不同步也不报错。配好后内核每小时同步一次，平台推人员变动时也会同步；同一页的「立即同步」手动触发（`POST /api/v1/orgs/:orgId/plugins/:plugin/directory/sync`）。同步只加人（角色 member）与撤销**由通讯录加入的**成员关系，手动 / 邀请加入的人不会被同步移除。

**行为须知**
- **离职处理吊销的会话与令牌是账号级的**：通讯录判定离职、管理员移出或本人离开某个组织时，此人所有的网页会话与个人令牌都被吊销（不只是该组织的），需要重新登录（Ruling A8）。同时删除他在该组织的个人连接器凭据、中止他在该组织的进行中运行。
- **同一个群话题里的匿名访客共用一个对话**（连接为 `anonymous` 时）：话题里所有未绑定的人共用同一段对话上下文，任何一个都能对该对话的审批卡片做「仅此一次」的批准（Ruling A16）。
- **没有绑定外部身份的本地账号会被通讯录同步出第二个账号**：通讯录同步不按邮箱合并。要避免，先让此人用本地账号在 IM 里私聊机器人完成绑定，或在受信租户下用第三方登录按已验证邮箱合并（目前只有 Slack 登录可以），再开通讯录同步（Ruling A9 的结果）。
- **经 IM 绑定的身份不能直接用于网页登录**：在 IM 里点绑定卡片建立的身份只能在 IM 里代表本人；要用它登录网页，先登录绑定的那个账号，再在登录状态下完成一次该平台的第三方登录（「设置 → IM 身份」里该身份的「验证」）。通讯录同步建立的身份不受此限（Ruling A18 / A23）。
- **群里的话题跟进需要再 @ 机器人**：群聊里只处理 @ 了机器人的消息，话题里不 @ 的回复会被忽略（D4）。
- **大批移除保护**：定时与人员变动触发的同步，计划移除人数超过 `max(5, 现有通讯录成员的 20%)`，或通讯录里一个在职成员都没有时，本轮不移除任何人并记审计 `org.directory.removal_blocked`。确认是真实的大批离职时，用「立即同步」手动触发，手动同步不受此限；但手动同步时如果正好有另一轮同步在跑，它会改由那一轮结束后的补跑完成，补跑按 `changed` 触发处理，仍受保护（Ruling A17）。
- **人员变动不断时移除会推迟**：一轮同步进行中又来了人员变动，这一轮只加人不移除，移除留给随后的补跑（Ruling A32）。变动持续不断时移除会一直推迟。
- **Slack Enterprise Grid**：租户是工作区（team），不是企业。同一企业其他工作区的人在共享频道里发言时按外部租户处理，只能绑定、不能匿名；通讯录只同步 `teamId` 这个工作区的正式成员，访客（单 / 多频道）不同步（Ruling A26 / A27 / A29）。
- **其他限制**：Sign in with Slack 不用 PKCE（Slack OIDC 未声明），任何工作区的 Slack 用户都能完成登录（只建账号）；Lark 登录只服务于部署级登录应用所在的租户，其他租户的组织照样可以用机器人并在 IM 里绑定；Slack 发送没有幂等参数，超长回复拆成多条时中途失败重试可能重复前几段；IM 里暂不支持仅自己可见的回复（ephemeral）。
- **尚待真实平台联调确认**（目前只在假服务端上验证）：Lark 卡片回调在回失败后是否像事件一样重推（不重推时这次点击丢失、需再点）；Lark 卡片回调以事件帧到达、JSON 2.0 卡片里多选表单与按钮布局的渲染；Lark 长连接 WSS 主机名；Lark v2 token 接口的返回码类型与部门递归分页在结构不变时的稳定性；Slack Socket Mode 的重连与限流在真实工作区的表现。

写渠道、登录、通讯录插件见 [skills/writing-channels](skills/writing-channels/SKILL.md)。

### 对话页的右侧面板与插件界面

对话页中间是对话，工具调用按时间线一行一条（工具给了显示摘要就显示那句话，如「更新任务清单（4 项）」，展开看完整的输入输出）。右侧是可以收起的标签面板：

- 内核自带的标签：「运行」（本次对话的全部工具调用，有待批准的操作时带提醒标记）和「上下文」（已用 token / 上下文窗口、agent 与模型、用到的应用、压缩记录）。
- 插件的标签：组织启用了带界面的插件后自动出现。例如启用 `@capybara-hq/plugin-todo`，就多一个「任务」标签，agent 每次更新清单都会实时刷新。插件也能往顶栏的「扩展」菜单加组织页面。

插件界面分两档：

- **渲染 schema 视图**：插件只返回结构化的块（清单、表格、图表、按钮、表单等），网页用设计系统组件画。插件写不了样式，也执行不了代码。升级时多出视图不需要重新批准。参考 `plugins/todo`。
- **嵌入应用**：插件自己的页面放进沙箱 iframe，用来做看板、工作流这类复杂交互。页面经同源代理 `/plugin-ui/<插件>/...` 加载，读不到会话 Cookie，只拿到一个只对这个插件有效、5 分钟过期的令牌。嵌入应用在 `capybara plugins review` 里标为 `(sensitive)`，必须批准后才加载。参考 `plugins/example-board`：加进 `CAPYBARA_PLUGINS` 并在组织启用后，从顶栏「扩展」菜单打开组织看板，对话里会多一个「看板」标签。

写插件界面见 [skills/writing-plugin-ui](skills/writing-plugin-ui/SKILL.md)。

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
