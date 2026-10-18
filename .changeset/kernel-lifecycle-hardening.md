---
"@capybara-hq/kernel": minor
---

生命周期加固：停机分阶段预算（迁移 2s / HTTP 10s / 运行 10s / 插件 5s，总时限 30s；插件的停机清理须在 5s 内完成）；插件按拓扑序逆序串行关闭，停机期间进行中的加载会放弃并释放连接；所有角色都监听 HTTP（worker-only 只暴露 `/healthz`、`/readyz`）；新增 `db.connectTimeoutMs`（默认 5000）；`ctx.db.destroy()` 被禁止；相对 `resolveFrom` 按 cwd 解析。
