---
"@capybara-hq/kernel": minor
---

通讯录同步（`directory@1`）：维护队列每小时 `directory-scan`，给「插件提供通讯录、在该组织启用、组织级配置有效」的
(组织, 插件) 投递同步（job id `directory-sync-<org>-<plugin>-<小时桶>`）；`POST /api/v1/orgs/:orgId/plugins/:plugin/directory/sync`
（`org.members.manage`，只能由人发起）手动触发并返回 202 与 job id；入站 `directory_changed` 按分钟桶去重触发。
同一 (组织, 插件) 同时只跑一个同步（Redis 锁）；被锁挡掉的请求记脏标记，持有者跑完后补一轮。
非手动触发时有大批移除保护：计划移除超过 max(5, 20%) 或通讯录没有在职成员时不删人并审计 `org.directory.removal_blocked`。在职成员按 `<插件>:<租户>` 解析外部身份（不合并、不建会话），
不是成员就以 member 加入（`memberships.source = "directory:<插件>"`）；整轮分页成功走完后，离职或不再出现、且由该通讯录加入的
成员逐个走离职处理（每人一个事务），中途失败不移除任何人，手动加入的成员永远不被同步移除，最后一个 owner 跳过；
审计 `org.directory.synced`（added / removed / skippedLastOwner / failed / total / partial）。`Kernel.identity.directory` 新增。
