# Capybara

开源的企业级 Agent 平台。内核精简，能力以插件提供。TypeScript / Node 24 / pnpm monorepo，Apache-2.0。

## 快速开始

```bash
pnpm install
docker compose -f docker/compose.dev.yaml up -d
pnpm lint && pnpm typecheck && pnpm test
```

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，面向 Agent 的仓库说明见 [AGENTS.md](AGENTS.md)。

## 许可证

[Apache-2.0](LICENSE)
