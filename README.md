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
| `@capybara-hq/plugin-openai-compatible` | **默认发行版自带**。OpenAI 兼容的 Chat Completions 服务（DeepSeek、Qwen、vLLM 等），按端点配置、方言预设差异 |
| `@capybara-hq/plugin-model-fake` | 确定性脚本化模型，用于测试与无密钥演示 |
| `@capybara-hq/plugin-anthropic` | Anthropic（官方 SDK + 原生 Messages API），**按需安装** |
| `@capybara-hq/plugin-openai` | OpenAI（官方 SDK + 原生 Responses API），**按需安装** |

可以同时加载多个，如 `CAPYBARA_PLUGINS='["@capybara-hq/plugin-openai-compatible","@capybara-hq/plugin-anthropic"]'`，`CAPYBARA_PLUGIN_CONFIG` 里按插件名分别给配置。`anthropic` 与 `openai` 不在默认发行版里：自建部署时先安装对应的包（如 `pnpm add @capybara-hq/plugin-anthropic`），再把它加进 `CAPYBARA_PLUGINS`。

每个模型在插件里声明自己支持的参数（`effort`、`thinking`、`temperature`、`maxOutputTokens` 等标准旋钮，以及 `<插件名>.<名称>` 形式的厂商参数）；网页的 agent 表单按声明渲染，agent 版本保存时按声明校验。

`openai-compatible` 接 DeepSeek 的部署级配置示例（默认示例）：

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-openai-compatible"]'
export CAPYBARA_PLUGIN_CONFIG='{"openai-compatible":{"endpoints":[{"name":"deepseek","baseUrl":"https://api.deepseek.com","dialect":"deepseek","models":[{"id":"deepseek-flash","contextWindow":128000,"maxOutputTokens":8192,"reasoning":true}]}],"apiKeys":{"deepseek":"sk-..."}}}'
```

- `endpoints`（至少一个）：`name`（端点名，不含 `/`）、`baseUrl`、`dialect`（`generic` / `deepseek` / `qwen`）、`models`（至少一个：`id`、`contextWindow`、`maxOutputTokens`，可选 `reasoning`、`vision`、`caching`、`streamIdleTimeoutMs`）；可选 `midConversationSystem`（覆盖方言默认）。对外模型 id 为 `<端点名>/<模型 id>`，如 `deepseek/deepseek-flash`。上例的 `contextWindow` / `maxOutputTokens` 只是占位，请按所用模型的官方文档填写。
- `apiKeys`：端点名 → 密钥，是**顶层**的密钥字段（密钥不能放进 `endpoints[]` 数组元素里）；键必须是已配置的端点名，无密钥的端点（如内网 vLLM）不填。
- 方言：`deepseek` 提供 `thinking`（`on|off`，默认 `on`）与 `effort`（`low|high|max`，默认 `high`），思考内容经 `reasoning_content` 读取并按 DeepSeek 的规则回传；`qwen` 提供 `thinking`（映射为 `enable_thinking`）；`generic` 只提供 `temperature` 与 `maxOutputTokens`。所有方言都声明 `temperature` 与 `maxOutputTokens`；思考相关参数只对配置了 `reasoning: true` 的模型声明。
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
