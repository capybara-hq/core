---
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
---

内核 HTTP 层从 Hono 迁到 NestJS + Fastify：`Kernel.app` 改为 `Kernel.http`（`inject()` / `routes()`），新增 `createHttpApp`、`ApiError` 与统一错误信封；插件契约不变。双副本工具的 `.ts` runner 显式指定仓库 tsconfig（开启装饰器）。
