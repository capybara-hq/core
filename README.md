# Capybara

开源的企业级 Agent 平台。内核精简，能力以插件提供。TypeScript / Node 24 / pnpm monorepo，Apache-2.0。

## 快速开始

需要 Node 24、pnpm、Docker、openssl。数据库要求 PostgreSQL ≥ 15（迁移用到 `UNIQUE NULLS NOT DISTINCT`；开发与 CI 用 17）。

```bash
pnpm install
docker compose -f docker/compose.dev.yaml up -d      # postgres:5432 + valkey:6379 + seaweedfs（S3 API 8333）

export CAPYBARA_DB__URL=postgres://capybara:capybara@localhost:5432/capybara
export CAPYBARA_REDIS__URL=redis://localhost:6379
export CAPYBARA_MASTER_KEY=$(openssl rand -base64 32)
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-example-counter"]'
export CAPYBARA_PLUGIN_CONFIG='{"example-counter":{"step":1}}'   # 可选，step 默认 1
export CAPYBARA_PLUGIN_PERMISSIONS__AUTO_APPROVE=true   # 仅本地试用：自动批准插件权限（生产保持关闭）

pnpm capybara migrate     # 迁移内核与插件 schema
pnpm capybara start       # 监听 :8080（CAPYBARA_HTTP__PORT 可改）
```

这里用启动配置的 `CAPYBARA_PLUGINS` 直接加载工作区里的插件（开发模式，来源 `config`）；生产部署按插件包安装，见下文「插件：安装、生命周期与管理后台」。`openai-compatible` 与 `object-store-s3` 随 CLI 内置，不用写进 `CAPYBARA_PLUGINS`。

插件权限：插件首次出现、或升级后清单比已批准的权限多出任何一项时**不加载**（启动日志有 warn），依赖它的插件同样不加载；
权限变少或不变直接加载。生产不要开 `autoApprove`，改由企业管理员在网页「管理 → 插件」里审阅批准，或用 CLI（直连 PG，会先执行内核迁移）。批准后运行中的副本**不用重启**就会加载（CLI 写完 PG 经 Redis 通知各副本；通知失败时等下一个 reconcile 周期）：

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
- 给已有的本地账号授予或撤销企业管理员：`pnpm capybara admin grant <登录名>` / `pnpm capybara admin revoke <登录名>`（写审计；不能撤销最后一个活跃的企业管理员）。企业管理员在网页顶栏「管理」（`/admin`）里管理账号、组织（运行并发、沙箱 CPU / 内存）、部署设置（价格币种、是否允许组织自建连接器 / 技能）、插件（安装、批准、部署级配置）、模型价格与用途映射、企业目录。企业管理员默认**读不到对话**：轨迹与评测只给组织管理员与 agent 负责人。
- 用浏览器在非 localhost 的明文 http 上试用时，设 `CAPYBARA_AUTH__COOKIE_SECURE=false`，否则浏览器不保存会话 Cookie；生产保持默认 `true`。

### 插件：安装、生命周期与管理后台

核心镜像只内置两个插件：`openai-compatible`（模型）与 `object-store-s3`（对象存储），由 CLI 以内置插件传给内核（来源 `builtin`）：预先批准、始终启用、不需要组织启用、不能卸载或停用，只需填部署级配置（没配好时后台显示「待配置」，内核照常启动）。其余插件在镜像之外，按**插件包**（npm-pack tgz：单文件 ESM、三方依赖已打进去，只有 `@capybara-hq/plugin-sdk` 与 `zod` 由宿主提供）装进插件目录：

- 打包：`pnpm pack-plugin plugins/<名>`（`pnpm pack-plugins` 打全部官方插件，输出 `artifacts/plugins/`）。
- 安装：企业管理员在「管理 → 插件 → 安装」上传 tgz 或填 npm 包名与版本（`packages.npmRegistry`，私有 registry 的令牌 `packages.npmToken`），看过权限审阅（敏感项与迁移警告高亮）后安装、批准、启用；也可以用 CLI：

```bash
pnpm capybara plugins install ./artifacts/plugins/capybara-hq-plugin-todo-0.1.0.tgz   # 或 npm:@capybara-hq/plugin-todo@0.1.0
pnpm capybara plugins approve todo
pnpm capybara plugins enable todo
pnpm capybara plugins list            # 各插件的期望状态与各副本是否一致
pnpm capybara plugins disable todo    # 卸载前须先停用：pnpm capybara plugins uninstall todo
```

- **安装、启用、停用、升级、卸载都不重启**：后台与 CLI 只写 PG 里的期望状态，各副本收到通知后自行加载 / 撤销（维护任务每 `pluginHost.reconcileIntervalSeconds` 秒兜底一次）。换版本时先加载新版、再撤销旧版；停用或升级时进行中的工具调用最多等 `pluginHost.drainSeconds`（默认 30 秒）。新版本要的权限多了就停在待批准，旧版本照常运行；插件迁移由一个副本持锁执行，只做扩展；降级只能回到迁移都执行过的版本。卸载不删数据（插件 schema、密钥、组织配置、批准记录都保留）。旧版本的代码留在进程内存里直到重启，同一进程升级很多次（> 20）时日志会提示重启该副本。
- **部署级配置可在后台改**（「管理 → 插件 → 配置」，存 PG，密钥加密）：优先级 环境变量 > 配置文件 / Nacos > 后台 > 默认值，启动配置里给出的字段在后台只读并显示来源。配置不合法时插件显示「待配置」、不加载，内核照常启动，改好后自动加载。
- 包存在对象存储的 `deployment/plugins/blobs/` 下（没配对象存储时存 PG），各副本按 sha256 同步到本地 `pluginHost.dir`（默认 `/var/lib/capybara/plugins`，可随时清空）。**换对象存储的桶或端点时要把 `deployment/` 前缀下的对象一起迁过去**，否则存在旧桶里的插件包与目录文件取不到，新副本同步失败。
- 经网页上传的包还受网页层的 `CAPYBARA_WEB_MAX_PACKAGE_BYTES`（默认 50 MiB）限制；调大内核 `packages.maxBytes` 时一起调大，见 [docs/config.md](docs/config.md)。

**从配置声明迁移到安装记录**（C15）：启动配置的 `plugins` 列表照样可用（开发模式与已有部署，来源 `config`），但这样声明的插件在后台只读，不能网页安装 / 升级 / 停用，改列表要重启；安装同名插件会返回 409 `plugin.config_declared`。内核不会自动转换，迁移步骤：

1. 准备同一个 npm 包的插件包（`pnpm pack-plugin plugins/<名>`，或用 npm 上的版本）：插件名归第一次使用它的 npm 包，换包名会被拒绝（`plugin.name_conflict`）。
2. 从 `plugins` 列表里去掉它（`pluginConfig` 里的部署配置可以留着，照样生效；也可以搬到后台），滚动重启各副本。此时插件不加载，依赖它的插件随之卸下（后台显示 `dependency`），插件装回后自动重新加载。
3. 上传 / npm 安装该包并启用（后台或 `capybara plugins install …` + `enable`）。插件 schema、密钥、组织配置与批准记录都沿用；新包的权限没超出已批准的就直接加载。

**信任模型**：插件在内核进程里全权运行（插件的迁移 SQL 也以内核的数据库连接执行）。权限清单、批准与目录策略是**治理与审计，不是沙箱**：它们管住内核握着的资源（密钥、存储、工具、会话内容），管不住插件直连数据库或网络。只安装你信任的发布者的包，批准前看迁移 SQL（写到插件自己 schema 之外、改权限、`DO` 块等会列为敏感警告，警告变了要重新批准）；不要对不受信的源码运行 `pnpm pack-plugin`（打包会执行插件代码）。不受信的扩展做成外部应用，经 HTTP 调内核。写插件见 [skills/writing-plugins](skills/writing-plugins/SKILL.md)。

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
| `@capybara-hq/plugin-openai-compatible` | **内置**（随 CLI，不用安装、不用写进 `CAPYBARA_PLUGINS`）。OpenAI 兼容的 Chat Completions 服务（DeepSeek、Qwen、vLLM 等），按端点配置、方言预设差异 |
| `@capybara-hq/plugin-model-fake` | 确定性脚本化模型，用于测试与无密钥演示 |
| `@capybara-hq/plugin-anthropic` | Anthropic（官方 SDK + 原生 Messages API），**按需安装** |
| `@capybara-hq/plugin-openai` | OpenAI（官方 SDK + 原生 Responses API），**按需安装** |

可以同时用多个：`openai-compatible` 是内置的，其余按插件包安装（见上文「插件：安装、生命周期与管理后台」），开发时也可以写进 `CAPYBARA_PLUGINS`（如 `'["@capybara-hq/plugin-anthropic"]'`）；部署级配置在 `CAPYBARA_PLUGIN_CONFIG` 里按插件名分别给，或由企业管理员在后台填写。`anthropic` 与 `openai` 不在核心镜像里，要用时自行安装。

每个模型在插件里声明自己支持的参数（`effort`、`thinking`、`temperature`、`maxOutputTokens` 等标准旋钮，以及 `<插件名>.<名称>` 形式的厂商参数）；网页的 agent 表单按声明渲染，agent 版本保存时按声明校验。

`openai-compatible` 接 DeepSeek 的部署级配置示例（默认示例）：

```bash
export CAPYBARA_PLUGIN_CONFIG='{"openai-compatible":{"endpoints":[{"name":"deepseek","baseUrl":"https://api.deepseek.com","dialect":"deepseek","models":[{"id":"deepseek-flash","contextWindow":1048576,"maxOutputTokens":393216,"reasoning":true}]}],"apiKeys":{"deepseek":"sk-..."}}}'
```

- `endpoints`（至少一个）：`name`（端点名，不含 `/`）、`baseUrl`、`dialect`（`generic` / `deepseek` / `qwen` / `ark`；方舟 baseUrl 为 `https://ark.cn-beijing.volces.com/api/v3`）、`models`（至少一个：`id`、`contextWindow`、`maxOutputTokens`，可选 `reasoning`、`vision`、`documents`（收 PDF；只有 generic、qwen 方言可开启）、`caching`、`streamIdleTimeoutMs`）；可选 `midConversationSystem`（覆盖方言默认）。对外模型 id 为 `<端点名>/<模型 id>`，如 `deepseek/deepseek-flash`。上例的 `contextWindow` / `maxOutputTokens` 取自 DeepSeek `GET /models` 对 `deepseek-flash` 的返回；其他模型以其官方返回为准。
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
- `models`（至少一个）：`id`、`contextWindow`、`maxOutputTokens`、`reasoning`、`vision`，可选 `documents`（是否收 PDF，缺省 false）、`streamIdleTimeoutMs`（推理模型长时间无输出时的看门狗阈值）、`effortLevels`（该模型接受的 effort 档位，取自 `low|medium|high|xhigh|max`，按给定顺序声明；未给时为 `low|medium|high`，所有推理模型都接受；档位因模型而异，例如 gpt-5-nano 不接受 `max`）。
- `reasoningSummary`：`auto`（默认）请求推理摘要，agent 可用 thinking 参数关闭；未完成组织验证的账号请求摘要会被拒绝，此时设 `off`，模型也不再声明 thinking 参数。
- 以 `store: false` 调用，推理项以加密内容原样回放；SDK 同样不做重试。

真实接口的一致性测试默认跳过，设了环境变量才跑：anthropic 用 `CAPYBARA_TEST_ANTHROPIC_API_KEY`；openai 用 `CAPYBARA_TEST_OPENAI_API_KEY` 与 `CAPYBARA_TEST_OPENAI_MODEL`；openai-compatible 用 `CAPYBARA_TEST_OAICOMPAT_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIALECT`（四个都设才跑）。

写模型供应商插件见 [skills/writing-model-providers](skills/writing-model-providers/SKILL.md)。

`example-counter` 是写插件的参考实现；写自己的插件见 [skills/writing-plugins](skills/writing-plugins/SKILL.md)，配置项清单见 [docs/config.md](docs/config.md)。

### 工具与连接器（MCP / OpenAPI）

agent 经「工具」做事。工具有三个来源：内置（`ask_user`、`read_tool_output`，工具多时自动加入 `tool_search`）、插件（如 `@capybara-hq/plugin-todo` 的任务清单工具）、**连接器**（把远端 MCP 服务或 OpenAPI 描述的 HTTP API 接进组织）。写操作默认触发审批，确认前 run 暂停，不占会话锁。

加载连接器插件（部署级，不需要按组织启用）：

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-connector-mcp","@capybara-hq/plugin-connector-openapi","@capybara-hq/plugin-todo"]'
# 生产只接受 https 端点；本机联调才打开 allowInsecureLoopback（明文 http 的 127.0.0.1 / localhost / [::1]）
export CAPYBARA_PLUGIN_CONFIG='{"connector-mcp":{"allowInsecureLoopback":true},"connector-openapi":{"allowInsecureLoopback":true}}'
```

**网页向导**（组织管理员）：登录后打开「连接器」→「安装」（`/connectors/install`）：选端点类型（MCP 服务 / OpenAPI 文档）→ 填端点（OpenAPI 可给文档 URL 或上传 JSON / YAML，最大 2 MB；`baseUrl` 可覆盖文档里的 servers）→ 选认证（OpenAPI 会按文档声明的 `securitySchemes` 预填，并列出操作供勾选）→ 预览工具与默认策略 → 安装。安装后的连接器详情页可调整每个工具的启停与默认策略，并复核漂移（见下）。在 agent 表单里选上该连接器的工具，agent 才会用到它。

**API**（用管理员的会话 Cookie 或令牌；写请求带 `X-Capybara-Csrf: 1`）：

```bash
# 安装一个 MCP 连接器（静态 Bearer，组织共用一个凭据）
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/connectors -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"name":"Docs","slug":"docs","connector":"mcp",
       "endpoint":{"url":"https://mcp.example.com/mcp"},
       "auth":{"type":"bearer","ownership":"org"},
       "credential":{"token":"<token>"}}'

# 安装一个 OpenAPI 连接器（API key 放 header；operations 缺省 = 全部操作）
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/connectors -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"name":"Petstore","slug":"pets","connector":"openapi",
       "endpoint":{"specUrl":"https://api.example.com/openapi.json","operations":["listPets","getPet"]},
       "auth":{"type":"api_key","ownership":"org","in":"header","name":"X-Api-Key"},
       "credential":{"token":"<key>"}}'

# 预览（什么都不写）：返回文档声明的认证方式、操作清单和工具预览
curl -s -X POST localhost:8080/api/v1/orgs/$ORG/connectors/preview -b cookies.txt \
  -H 'Content-Type: application/json' -H 'X-Capybara-Csrf: 1' \
  -d '{"connector":"openapi","endpoint":{"specUrl":"https://api.example.com/openapi.json"}}'
```

连接器工具在模型面前的名字是 `<slug>__<工具名>`（如 `docs__search`）。agent 定义里按引用选工具：`"tools":[{"kind":"connector","connectorId":"<id>","tools":"all"}]`（`"all"` = 该连接器当前所有启用的工具，也可给工具名数组）。

**认证方式**（`auth.type`；`ownership` 为 `org` 时全组织共用一个凭据，为 `personal` 时每位成员各自连接，在「设置 → 个人连接」里填写或授权）：

| `auth.type` | 说明 | 凭据 |
|---|---|---|
| `none` | 无需认证 | — |
| `bearer` / `basic` / `api_key{in,name}` / `headers{names}` | 静态凭据，加密存储，只在请求时注入 | `credential`：`{token}` / `{username,password}` / `{headers:{…}}`；安装后用 `PUT .../connectors/:connectorId/credentials/org` 轮换（个人凭据用 `.../credentials/me`） |
| `oauth_code`（个人） | 授权码 + PKCE：每位成员点「连接」跳转授权服务器登录；`discovery: "mcp"` 自动发现授权服务器，`client: "dcr"` 安装时自动注册客户端 | 授权服务器不支持 DCR 时改用 `client: "manual"`，安装时给 `credential: {clientId, clientSecret?}`；也可 `discovery: "manual"` 并给 `authorizationUrl` / `tokenUrl` |
| `oauth_client`（组织） | 客户端凭据流：组织共用一个 OAuth 客户端换令牌，安装时先验证 | `credential: {clientId, clientSecret}`，轮换用 `PUT .../credentials/org` |

- **OAuth 需要 `http.publicUrl`**（`CAPYBARA_HTTP__PUBLIC_URL`）：填**网页（`apps/web`）的外部可达源**，如 `https://capybara.example.com`，而不是内核自己的地址。回调地址是 `<publicUrl>/api/v1/oauth/callback`，须登记到授权服务器；它经网页的 `/api` 代理转给内核——发起连接时的绑定 cookie 也是经这个代理设在网页源上的，回调完成后再跳回 `<publicUrl>` 下的网页页面，所以三者必须同源。没配时安装 OAuth 应用会被拒绝。令牌在过期前由内核自动刷新，刷新被拒则凭据作废，成员会在对话里看到「需要连接」卡片。
- 凭据不进事件日志、模型上下文与审计；工具结果与错误里出现的凭据值会被内核打码。端点的固定头与 URL query 里不能放凭据。

**审批与收件箱**：策略（`allow` / `ask` / `deny`）默认按工具注解推导（只读 → `allow`，其余 → `ask`），管理员可逐工具改，agent 还可以把某个工具收紧。`ask` 的调用在对话里出审批卡片，也汇总在网页的「收件箱」（`/inbox`）；批准时可选「仅这次 / 本会话 / 以后都允许」，「以后都允许」的授权在「设置 → 授权」里查看与撤销，工具定义一变即失效。审批超过 `tools.approvalTimeoutHours`（默认 24）按拒绝处理；agent 自己不能审批。远端工具在调用途中向用户要输入（MCP elicitation）时，对话里出输入卡片。API：`/api/v1/orgs/:orgId/approvals`、`/questions`、`/me/tool-grants`。

**工具定义漂移**：内核每 `tools.driftIntervalHours` 小时（默认 24）、收到远端的 `list_changed` 通知、管理员点「刷新」时重新读取连接器的工具清单。新增或定义有任何变化的工具先进入「待复核」，复核（批准 / 拒绝）前模型用不到，防止远端偷偷改工具描述。

**`tool_search`**：agent 可用工具超过 `tools.searchThresholdTools`（30）个或估算超过 `tools.searchThresholdTokens`（8000）token 时，不再把全部定义塞进每次请求，而是给一份工具目录，模型用 `tool_search` 按关键词加载需要的。组织管理员可在「设置 → 组织」关闭（`PATCH /api/v1/orgs/:orgId/settings {"toolSearch":"off"}`）。

**插件工具要先在组织启用**：插件工具（如 `todo__write`）只在启用了该插件的组织可用（连接器不需要）。组织管理员：

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

**2. 装插件并批准权限**：企业管理员在「管理 → 插件」安装 `@capybara-hq/plugin-slack` / `@capybara-hq/plugin-lark` 的插件包（或 `pnpm capybara plugins install npm:@capybara-hq/plugin-slack`；开发时也可写进 `CAPYBARA_PLUGINS`）。新插件首次出现时不加载，在安装确认页或用 `pnpm capybara plugins review` 查看它要的权限（两个插件只声明了 `permissions.network`，并提供三种能力、带部署级与组织级配置；渠道、登录、通讯录提供方标为敏感），批准（网页或 `pnpm capybara plugins approve slack` / `approve lark`）并启用后各副本不用重启即加载。`pluginPermissions.autoApprove` 只用于本地开发与试用。

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

- 内核自带的标签：「运行」（本次对话的全部工具调用，有待批准的操作时带提醒标记）和「上下文」（已用 token / 上下文窗口、agent 与模型、用到的连接器、压缩记录）。
- 插件的标签：组织启用了带界面的插件后自动出现。例如启用 `@capybara-hq/plugin-todo`，就多一个「任务」标签，agent 每次更新清单都会实时刷新。插件也能往顶栏的「扩展」菜单加组织页面。

插件界面分两档：

- **渲染 schema 视图**：插件只返回结构化的块（清单、表格、图表、按钮、表单等），网页用设计系统组件画。插件写不了样式，也执行不了代码。升级时多出视图不需要重新批准。参考 `plugins/todo`。
- **嵌入应用**：插件自己的页面放进沙箱 iframe，用来做看板、工作流这类复杂交互。页面经同源代理 `/plugin-ui/<插件>/...` 加载，读不到会话 Cookie，只拿到一个只对这个插件有效、5 分钟过期的令牌。嵌入应用在 `capybara plugins review` 里标为 `(sensitive)`，必须批准后才加载。参考 `plugins/example-board`：加进 `CAPYBARA_PLUGINS` 并在组织启用后，从顶栏「扩展」菜单打开组织看板，对话里会多一个「看板」标签。

写插件界面见 [skills/writing-plugin-ui](skills/writing-plugin-ui/SKILL.md)。

### 对象存储（附件、产物、技能文件）

对象存储由 `object-store@1` 插件提供，默认实现 `@capybara-hq/plugin-object-store-s3`（官方 `@aws-sdk/client-s3`）：AWS S3、MinIO、Ceph、SeaweedFS，以及提供 S3 兼容接口的阿里云 OSS、火山引擎 TOS 都能用。一个部署一个桶；插件经 `ctx.storage` 读写，键自动加前缀 `plugins/<插件>/<组织 id>/`（内核自己用 `kernel/<组织 id>/`），互相看不到。大文件由浏览器经预签名 URL 直传、直接下载，不经内核中转；上传大小由存储端按策略限制。

本地的 `docker/compose.dev.yaml` 自带官方 SeaweedFS 镜像（`chrislusf/seaweedfs`，按标签加摘要固定）：S3 API 在 `localhost:8333`，凭据 `capybara` / `capybara-secret`，filer 的文件浏览页在 <http://localhost:8888>。一次性容器 `createbuckets` 建好桶 `capybara`。测试用同一个镜像（`startTestS3()`），可用 `CAPYBARA_TEST_S3_IMAGE` 换成私有镜像源。启用：

`object-store-s3` 是内置插件，不用写进 `CAPYBARA_PLUGINS`，只给部署级配置（也可以由企业管理员在后台填）：

```bash
export CAPYBARA_PLUGIN_CONFIG='{"object-store-s3":{"endpoint":"http://localhost:8333","region":"us-east-1","bucket":"capybara","accessKeyId":"capybara","secretAccessKey":"capybara-secret","forcePathStyle":true}}'
# 或逐字段：CAPYBARA_PLUGIN_CONFIG__OBJECT_STORE_S3__SECRET_ACCESS_KEY=...
```

| 字段 | 说明 |
|---|---|
| `endpoint` | S3 兼容服务的地址；用 AWS S3 时不填（按 `region` 取端点） |
| `region` | 区域；SeaweedFS、MinIO 填 `us-east-1` |
| `bucket` | 桶名（须事先建好） |
| `accessKeyId` / `secretAccessKey` | 凭据（密钥字段，加密存储、日志打码） |
| `forcePathStyle` | 路径风格访问（`<endpoint>/<bucket>/<key>`），SeaweedFS、MinIO、Ceph 一般要开；默认 `false` |
| `publicEndpoint` | 浏览器可达的地址，预签名 URL 用它签名；内核走内网 `endpoint`、浏览器走公网域名时填写 |

浏览器直传与直接下载时，桶要允许网页来源的跨域请求（CORS：`GET`、`POST`、`PUT` 与 `Content-Type` 等请求头）。`AllowedOrigins` 填网页的来源（协议 + 域名 + 端口）。

AWS S3（控制台「权限 → 跨源资源共享 (CORS)」里粘贴）：

```json
[
  {
    "AllowedOrigins": ["https://capybara.example.com"],
    "AllowedMethods": ["GET", "POST", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

MinIO、Ceph 等支持 `PutBucketCors` 的 S3 兼容存储，用 AWS CLI 指向自己的端点（`aws s3api put-bucket-cors --endpoint-url http://minio:9000 --bucket capybara --cors-configuration file://cors.json`）：

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://capybara.example.com"],
      "AllowedMethods": ["GET", "POST", "PUT"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

不支持按桶配置 CORS 的旧版 MinIO 用环境变量 `MINIO_API_CORS_ALLOW_ORIGIN` 设置允许的来源。SeaweedFS 默认允许跨域请求，开发编排与测试不需要另配。

对象存储插件没配置好（后台显示「待配置」）时：声明了 `permissions.storage` 的插件不加载（`capybara plugins review` 与启动日志里说明缺 `object-store@1`），内核里依赖存储的功能返回 `storage.unavailable`（503）。组织删除后，它的对象在 `storage.purgeDeletedOrgsAfterDays`（默认 30）天后由维护任务彻底删除。组织还在时，技能的对象不随删除而清理：被删除（软删除）的技能、技能的旧版本、已删除 agent 的 agent 级技能，文件都留在对象存储里，直到组织被删除后的这次清理（日志里的技能目录快照与已加载的版本仍引用它们）。

**附件与图片 / PDF 输入**：装了对象存储后，对话输入框可以加附件（默认单个 ≤ 20MB、每条消息 ≤ 10 个，类型限 PNG / JPEG / GIF / WebP、PDF 与纯文本 / Markdown / CSV，见 `docs/config.md` 的 `attachments.*`）。模型声明支持图片（`vision`）或文档（`documents`）时收到原文件，不支持时只收到英文文字占位，字节绝不发给不支持的模型；事件日志只记附件引用。单次请求的媒体总量由 `attachments.requestMediaBytes` 限制，超出时较早的附件换成占位。写存储插件见 [skills/writing-object-store-providers](skills/writing-object-store-providers/SKILL.md)。

### 对话沙箱（Docker）

沙箱由 `sandbox@1` 插件提供，Docker 实现是 `@capybara-hq/plugin-sandbox-docker`：每个对话一个容器（runc 或 gVisor 的 runsc），文件在卷上，空闲时休眠、长期不用时销毁；出站默认按白名单经代理放行。插件只经 socket 代理（`docker/sandbox-proxy`）访问 Docker，自己不挂 `docker.sock`。本地：

```bash
docker compose -f docker/compose.dev.yaml --profile sandbox up -d   # 构建沙箱与出站代理镜像，起 socket 代理（127.0.0.1:2375）
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-sandbox-docker"]'
export CAPYBARA_PLUGIN_CONFIG='{"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375"}}'
```

生产部署：

- **镜像**：`docker build -t capybara-sandbox:latest plugins/sandbox-docker/image`（标签与内核配置 `sandbox.image` 的默认值一致）、`docker build -t capybara-sandbox-egress:latest plugins/sandbox-docker/egress-proxy`，推到自己的仓库后在**每个 Docker 节点上预先拉好**（不在本地时第一次用沙箱才拉，可能拖过那次工具调用的时限）。要 gVisor 时先在守护进程里登记 `runsc`，插件配置加 `"runtime":"runsc"`。
- **socket 代理的位置**：能访问代理就几乎能控制 Docker。`127.0.0.1:2375` 只供本机开发；生产环境**绝不要把它发布到宿主机的任何地址上（包括 127.0.0.1）**，只放在内核所在的内部网络里（`endpoint` 填 `tcp://sandbox-proxy:2375`），沙箱不接那个网络。
- **出站**：`sandbox.limits.egress` 默认 `allowlist`，只放行 `sandbox.limits.allowHosts`（预置 npm、PyPI 与 GitHub 的克隆、归档、raw 与 release 下载地址；不预置 Debian 源：沙箱用户没有 sudo，装不了 apt 包，系统包请装进镜像），代理按解析后的 IP 拒绝内网与云元数据地址；`none` 断网；`open` 须显式打开插件配置 `allowOpenEgress`（默认关），只在可信环境用。组织管理员可在组织设置里改本组织的沙箱网络（`sandboxEgress`）：换一份白名单（替换部署的清单）或断网，但不能比部署放得更开（没有 `open`，部署为 `none` 时只能选 `none`）。改出站与资源限制只影响之后新建的沙箱。默认的 local 卷驱动不限 `diskMb`。
- **长命令要放宽运行时限**：单条命令最长 `sandbox.limits.maxCommandSeconds`（默认 7200 秒），但命令也会在所属运行快到 `runtime.maxRunSeconds`（默认 900 秒）前被停掉（结果告诉模型是运行时限所致）。agent 要跑长命令时把 `runtime.maxRunSeconds` 调到不小于 `maxCommandSeconds`；不满足时内核启动会打 warn。

给 agent 加内置工具 `sandbox_bash` / `sandbox_read` / `sandbox_write` / `sandbox_edit` / `sandbox_glob` / `sandbox_grep` / `sandbox_deliver` 后就能用（默认不带）。沙箱工具默认直接执行。**沙箱隔离的是宿主机与内网，不是数据**：出站白名单挡得住内网与云元数据地址，挡不住把数据发到白名单里的主机（例如 `git push` 到 github.com、往 npm 发包）；对话里的附件与 agent 能读到的数据都可能这样流出。处理敏感数据的组织，管理员应在组织设置里把 `sandboxToolPolicy` 改成 `ask`（写、执行、交付需要审批），和 / 或把沙箱网络（`sandboxEgress`）设为不联网。附件自动放进 `/workspace/attachments/`，`sandbox_deliver` 交付的文件出现在对话页右侧的「产物」标签。空闲 10 分钟休眠（文件保留）、7 天不用销毁，见 `docs/config.md` 的 `sandbox.*`。配置项、隔离设置、磁盘限制与出站白名单的细节见 [plugins/sandbox-docker/README.md](plugins/sandbox-docker/README.md)；写沙箱插件见 [skills/writing-sandbox-providers](skills/writing-sandbox-providers/SKILL.md)。

### 对话沙箱（E2B）

另一个实现是 `@capybara-hq/plugin-sandbox-e2b`（与 Docker 二选一）：每个对话一个 E2B 沙箱（E2B 云或自托管），休眠用 E2B 的 pause、恢复用 connect，到点自动暂停而不删除；出站白名单映射到 E2B 的 `allowOut` / `denyOut`（按域名只管 80 / 443 端口）。模板由同一份 `plugins/sandbox-docker/image/Dockerfile` 构建：

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-sandbox-e2b"]'
export CAPYBARA_PLUGIN_CONFIG='{"sandbox-e2b":{"apiKey":"e2b_…","template":"capybara-sandbox"}}'
```

- **模板**：用 E2B 的 Template SDK 从 Dockerfile 构建（`Template().fromDockerfile(...)`，`cpuCount: 1`、`memoryMB: 2048` 与内核默认值一致），把模板名填进 `template`；改了 Dockerfile 要重建模板。E2B 的 CPU、内存、磁盘由模板决定，`sandbox.limits` 的这三项对它不生效，内核配置 `sandbox.image` 也不用。
- **出站比 Docker 弱**：E2B 的域名白名单只看 80 端口的 Host 头与 443 端口的 SNI，不核对目的 IP，沙箱可能借白名单里的域名连到任意地址；用了白名单时 E2B 还会放行到 8.8.8.8 的 DNS。对出站要求严的部署用 Docker。自托管 E2B 的内网与云元数据地址要在 E2B 的网络层自己挡掉；不支持域名白名单的版本设 `domainAllowlist: false`（`allowlist` 退化为 `none`）。
- Hobby 套餐的沙箱超时最多 1 小时，要把 `sandbox.limits.maxCommandSeconds` 调到 3480 以下。
- 企业管理员在后台给组织设的沙箱 CPU / 内存覆盖对 E2B 不生效（规格由模板决定），只对 Docker 实现有效。

模板构建步骤、自托管（`apiUrl` / `domain`）、出站与资源限制的局限见 [plugins/sandbox-e2b/README.md](plugins/sandbox-e2b/README.md)。

### 技能

技能兼容 Anthropic Agent Skills 格式：一个目录，根下是带 `name` / `description` frontmatter 的 `SKILL.md`，可以附脚本与其他文件。元数据在 PG，文件在对象存储（所以要先装对象存储插件）。

- **技能库**（顶栏「技能」）：组织管理员上传 zip（≤ 50MB，单个文件 ≤ 10MB，解压后合计 ≤ 50MB；`SKILL.md` 放在根目录或唯一的顶层文件夹里），同名再传生成新版本；成员可以浏览。编辑 agent 时在「技能」分组里勾选要用的组织技能。
- **运行时**：对话开始一次运行时，内核把这个 agent 可用的技能清单（名字 + 描述）写进对话日志并告诉模型；模型用内置工具 `skill_load` 按名字读取正文。带脚本的技能会复制进沙箱的 `/skills/<name>/`（只读，用 `sh` / `python3` 运行），agent 需要有沙箱工具。技能有变化时，模型在**下一次运行开始**时收到提醒。
- **agent 自己写技能**：给 agent 加内置工具 `skill_write`（默认不带）。私有 agent 写的立即生效；共享 agent 写技能时先由发起人在对话里确认这次工具调用，再进入 agent 负责人的「收件箱」等批准，批准前只有发起改动的那个对话能试用，批准后所有对话在下一次运行时用上新版本。负责人可以在 agent 编辑页删除 agent 自写的技能。

### 评测与轨迹

组织管理员在顶栏「评测」里工作（agent 负责人从 agent 详情页进入自己 agent 的运行记录）：

- **轨迹查看器**（`/trajectories`）：一次对话的事件时间线与 Span 瀑布，每次模型调用的 token、延迟与成本（按「管理 → 模型」里的价格表读时估算，币种取部署设置 `priceCurrency`，没有价格显示「—」），工具调用与审批链。只有组织管理员与该 agent 的负责人能看，无权时一律 404；每次查看都记审计 `trajectory.viewed`。
- **评测集**（`/evals`）：从真实对话加用例或抽样（一个评测集对应一个 agent；用例存日志快照，≤ `evals.maxCaseBytes`），换模型 / 参数 / 指令 / agent 版本做候选，选**单步回放**（逐次重发当时的模型请求比较）或**整轮回放**（在隐藏对话里重跑整轮，工具结果用当时记录的，**不执行任何工具**）。运行前显示预计请求数与 token，到 token 上限就停（`evals.defaultTokenCap` / `evals.maxTokenCap`）；每个组织同时执行的用例数受 `evals.orgConcurrency` 限制。结果有结构差异、可选的 LLM 评委（先在「设置 → 模型」或「管理 → 模型」给用途 `eval` 选模型）与人工通过 / 不通过。评测数据留在组织内，不提供导出。

写评测与回放相关代码见 [skills/replay-evals](skills/replay-evals/SKILL.md)。

### 企业目录、清单与应用包

企业目录在部署内（「管理 → 企业目录」），条目四种：**插件**、**连接器模板**（预设好端点与认证的连接器，组织只填凭据）、**技能**、**应用**（`app.yaml` 组合包：插件 + 连接器模板 + 技能）。企业管理员给每个条目设策略：`allow`（新条目默认）、`needs_approval`（组织管理员安装时转企业管理员批准，批准对该组织跨版本有效）、`disabled`（不能新装，已装的不受影响；**插件条目**设为 `disabled` 时，含该插件的应用也不能在组织里新启用它）。成员在顶栏「目录」里浏览并申请，申请进组织管理员收件箱。部署设置 `customConnectors` / `customSkills` 设为 `deny` 时，组织只能从目录安装连接器 / 技能（不影响 agent 用 `skill_write` 写自己的技能）。

- **条目来源**：手动上传（tgz；连接器模板与技能也可以是 zip）或 npm；**官方清单**（配置 `catalogs.official.*`，默认开启；官方清单在 M7 上线前是占位地址）；**企业清单**（「管理 → 企业目录 → 来源」添加，可多个，可带镜像与令牌）。清单是静态 `index.json`（格式见 `packages/plugin-sdk/schemas/catalog-index.v1.schema.json`），每 `catalogs.refreshIntervalMinutes` 分钟拉一次，也可手动刷新；清单里的条目先浏览，「引入」某个版本时才下载并建成目录条目，有新版本只提示、不自动拉取。
- **校验**：下载一律按清单里的 sha512 校验（不认 npm 元数据），不符拒绝（`catalog.integrity_mismatch`）；清单里的权限摘要只用于展示，与下载后算出的不一致时审阅页警告。签名 / provenance 在 M7。
- **网络与令牌**：清单地址、镜像与条目的 `tarball` 下载地址只接受 https（`catalogs.allowInsecureLoopback` 只供测试），不跟随重定向，响应有大小上限。企业清单的令牌只发往清单主地址的源（镜像在别的源上时不带），`tarball` 下载不带清单令牌；`tarball` 与 `packages.npmRegistry` 同源时带 `packages.npmToken`，别的源一律不带。**不要把令牌写在清单 URL 的 query 里**（URL 会存进 PG、显示在后台），用来源的「令牌」字段（加密存储，作为 `Authorization: Bearer` 发送）。内核不拦截解析到内网地址的 https URL：清单与 `tarball` 地址由企业管理员（及清单作者）决定，只添加你信任的清单。
- **离线部署**：设 `CAPYBARA_CATALOGS__OFFICIAL__ENABLED=false`（后台显示离线模式，从不访问官方清单），改用内网托管的企业清单与手动上传；npm 来源与应用包需要能访问 npm registry，把 `packages.npmRegistry` 指向内网镜像（如 Verdaccio、Nexus），私有 registry 的令牌放 `packages.npmToken`。
- **应用包**：`app.yaml` 按 npm 包名 + 版本范围 + lock（精确版本 + sha512）引用插件，插件包不打进应用包，导入时从 `packages.npmRegistry` 拉取并按 lock 校验——**离线部署导入应用包必须有 npm 镜像**。企业管理员导入时一次审阅全部插件的权限与迁移警告，确认时可以同时把插件装到部署并启用（`deployPlugins`）；不勾选时只建目录条目、不动部署，之后要在插件后台按条目里的 sha256 手动安装（组织安装时必选插件没装会提示「未部署」）。组织管理员安装应用 = 在本组织启用插件、按模板建连接器（填凭据）、导入技能，失败会撤销本次新建的部分；卸载只移除本次新建且别处不在用的组件，保留项列出原因。安装中途副本崩溃、超过 `directory.staleInstallMinutes`（默认 30）分钟仍在「安装中」的，以及失败的安装，都可以通过卸载清理。**M6 不支持应用升级**：先卸载再安装新版本。
- **插件条目与策略**：插件只能由企业管理员装到部署；组织侧的「安装」= 在本组织启用，受条目策略约束。组织直接启用插件（「设置 → 插件」）时，按把这个插件带进部署的全部目录条目判定，**最严格的生效**（任一条目 `disabled` 就不能启用，任一 `needs_approval` 且本组织未获批准就要先申请）；应用里的插件按应用条目的策略判定。不经目录安装的插件不受目录策略约束。例外：插件自己的目录条目设为 `disabled` 是总开关，不论有没有来源记录、经不经应用，都不能在组织里新启用它。

写连接器模板与应用包见 [skills/writing-apps](skills/writing-apps/SKILL.md)。

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
