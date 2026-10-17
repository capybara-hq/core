---
"@capybara-hq/kernel": minor
---

内核 API 新增组织、成员与角色：`/api/v1/orgs`（创建 / 列出 / 查看 / 改名 / 软删除 / 转让 / 离开）与 `/api/v1/orgs/:orgId/members`（列出 / 改角色 / 移出），`PUT /api/v1/me/current-org`，`GET /api/v1/me` 增加 `memberships`。组织级路由用 `@OrgAction` + OrgGuard 每请求从 PG 实时判定角色（guest < member < admin < owner），非成员一律 404；成员变更锁组织行串行化，保证始终至少一个 owner。
