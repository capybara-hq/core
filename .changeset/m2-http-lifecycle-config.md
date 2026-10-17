---
"@capybara-hq/kernel": patch
---

HTTP、生命周期与配置收尾：插件路由的 HEAD 请求按 GET 处理（不带响应体）；插件作用域内 Fastify 自身的错误（如请求体超过 1 MiB 的 413）返回内核错误信封；畸形 Host 返回 400 `validation_failed`；`plugin handler failed` 日志的路径经脱敏；Nest 启动日志降为 debug。停机时等待 listen 与关闭 HTTP 共用 10s 截止时间。`ctx.db` 递归拦截 `destroy`（含 `transaction().execute(cb)` / `connection().execute(cb)` 回调里的实例）。`capybara migrate` 同样拒绝密钥标记不可达的插件；插件 ctx 关闭失败记 warn。日志打码支持数字（≥ 4 位）与嵌套密钥（布尔不打码），改用按前缀分桶的编译匹配器（密钥集合变化时才重建），顶层 `ts` / `level` / `msg` 不再打码；组织级插件配置的密钥（≥ 12 个字符）在事务提交后登记到单独的有界集合（最多 10000 个）。Nacos 配置来源支持鉴权：`CAPYBARA_NACOS_USERNAME` / `CAPYBARA_NACOS_PASSWORD`（登录换取 accessToken，按 TTL 的 80% 或 403 续期）或 `CAPYBARA_NACOS_ACCESS_TOKEN`。
