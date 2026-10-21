---
"@capybara-hq/kernel": minor
---

渠道运行时：组织的渠道连接（`/api/v1/orgs/:orgId/channels` 列表 / 新建 / 详情 / 修改 / 删除与
`schema/:plugin`，需 `channels.manage`；插件须在组织启用，新建与轮换凭据前先 `verify`，密钥进密钥存储、GET 不回显）。
worker 副本经 Redis 租约 `capk:channel-lease:<id>` 选主，同一连接只有一个副本持有长连接，持有者崩溃后租约过期即由其他副本接管；
连接失败记 `last_error` 并指数退避。入站消息 24 小时去重、按外部身份找成员账号（未绑定回绑定卡片或按连接策略使用组织的匿名访客），
群聊需 @ 机器人，私聊 `/new` 开新对话。组织设置新增 `locale`（`zh` / `en`，默认 en），IM 固定话术按它选择。
新配置 `channels.leaseTtlMs`、`channels.scanIntervalMs`、`channels.retryBaseMs`；迁移 0018 新增渠道相关表。
离职兜底扫描改为按创建时间键集分页，卡住的运行不再挤占后面的运行。
