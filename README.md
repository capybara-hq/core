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

接下来可以邀请成员（`POST /api/v1/orgs/:orgId/invitations`）、按角色管理成员（`/api/v1/orgs/:orgId/members`）；内核 API 的写法见 [skills/writing-kernel-api](skills/writing-kernel-api/SKILL.md)。

用完：`docker compose -f docker/compose.dev.yaml down`（加 `-v` 同时清掉数据卷）。

`example-counter` 是写插件的参考实现；写自己的插件见 [skills/writing-plugins](skills/writing-plugins/SKILL.md)，配置项清单见 [docs/config.md](docs/config.md)。

## 开发

```bash
pnpm lint && pnpm typecheck && pnpm check && pnpm test   # 测试需要 Docker（Testcontainers）
```

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，面向 Agent 的仓库说明见 [AGENTS.md](AGENTS.md)。

## 许可证

[Apache-2.0](LICENSE)
