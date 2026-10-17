---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/testing": minor
---

M2 收尾与验收。

- plugin-sdk：新增 `model-provider@1` 契约（`ModelProvider` / `ModelRequest` / `ModelStreamEvent` / `ContentBlock` / `ProviderOpaque` / `ModelUsage`、`ModelError` 与 `isModelError` / `isRetryableKind`、`MODEL_PROVIDER_CAPABILITY`）。
- testing：新增 `describeModelProviderConformance` 供应商一致性套件与 `startFakeModelServer` 假模型服务（供插件用原生协议写夹具）；双副本工具新增 `Harness.kill(index)`（SIGKILL 模拟副本硬崩溃）、`Harness.request` 的返回值带 `replica`（取自响应头 `x-capybara-replica`）与 `replicaOf(response)`；新增 M2 双副本端到端验收（杀掉正在执行运行的副本，另一个副本续跑）。
- kernel：新增可选配置 `http.replicaId`（`CAPYBARA_HTTP__REPLICA_ID`），设置后每个响应带 `x-capybara-replica` 头。
- kernel：组织、邀请、令牌与插件配置收尾：`PUT /me/current-org` 在一个事务内锁组织行与该成员关系后再写会话；服务令牌访问其他组织的人类专属路由返回 404，已删除与不存在组织的 404 一致；管理员可以给自己降级；令牌 `expiresAt` 只接受晚于当前时间的完整 ISO 时间；邀请去掉冗余的成员预检查；组织级插件配置在可重复读事务内读取、已停用插件返回 `{ enabled: false, config: null }` 不做校验、`put` 同一事务内删除 schema 中已不存在的密钥、无记录时 `config` 存 `null`（迁移 `0004_plugin_org_config_nullable.sql`；滚动升级时须所有副本先升级，再出现 `config` 为 `null` 的行）。
