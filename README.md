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

用完：`docker compose -f docker/compose.dev.yaml down`（加 `-v` 同时清掉数据卷）。

`example-counter` 是写插件的参考实现；写自己的插件见 [skills/writing-plugins](skills/writing-plugins/SKILL.md)，配置项清单见 [docs/config.md](docs/config.md)。

## 开发

```bash
pnpm lint && pnpm typecheck && pnpm check && pnpm test   # 测试需要 Docker（Testcontainers）
```

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，面向 Agent 的仓库说明见 [AGENTS.md](AGENTS.md)。

## 许可证

[Apache-2.0](LICENSE)
