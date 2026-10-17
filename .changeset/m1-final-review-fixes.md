---
"@capybara-hq/kernel": minor
---

M1 收尾加固：插件两级配置中不在对象路径上的 `secret()`（union / transform / 数组元素等内部）拒绝加载；企业管理员写操作（撤销 / 停用、建号、改部署设置）在锁内复核发起人身份；组织写操作统一组织行锁与角色复核（含吊销服务令牌）；`GET /me/tokens` 与 `GET /orgs/:orgId/service-tokens` 改为返回 `{ tokens }`；框架错误新增通用码 `conflict` / `payload_too_large` / `unsupported_media_type` / `rate_limited`；改密码核对旧密码按账号限流；会话吊销以 PG 为准（Redis 丢数据不复活）；审计记录个人令牌 id；5xx 日志路径脱敏令牌；插件请求不再携带 `cap_at` / `cap_rt`。
