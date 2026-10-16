# 贡献指南

## 开发环境

- Node 24、pnpm 10
- 启动本地依赖：`docker compose -f docker/compose.dev.yaml up -d`（PostgreSQL 17 @ 5432、Valkey 8 @ 6379）
- `pnpm install` 后运行 `pnpm lint && pnpm typecheck && pnpm check && pnpm test`

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/)，例如 `feat(kernel): 增加配置加载`。CI 会在 PR 上用 commitlint 校验。

## Changeset

改动了会发布的包时，运行 `pnpm changeset` 并提交生成的文件。

## CLA 说明

本项目采用贡献者许可协议（CLA），首次提 PR 时由机器人引导签署。CLA 机器人上线（里程碑 M6）之前，**外部 PR 暂不合并**。CLA 文本将经法务审阅后公布。

无论如何，代码现在是、将来也始终以 Apache-2.0 开源。
