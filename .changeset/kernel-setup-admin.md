---
"@capybara-hq/kernel": minor
---

初始化向导与企业管理员：公开路由 `GET/POST /api/v1/setup`（无活跃企业管理员时建首个企业管理员并可同时建组织，咨询锁串行化并发初始化；配置 `auth.setupToken` 后需提供该 token），企业管理员端点 `/api/v1/admin/{accounts,orgs,settings}`（服务令牌一律 403，停用账号同时吊销其会话与个人令牌），启动时未初始化给出 warn。新增 CLI `capybara admin create`（密码只从 stdin 读）。配置文档对可选无默认值字段标「可选」。
