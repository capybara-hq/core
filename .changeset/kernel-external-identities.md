---
"@capybara-hq/kernel": minor
---

外部身份：经 `identity-source@1` 插件的第三方登录（`GET /api/v1/auth/sources`、`/api/v1/auth/sso/:plugin/start|callback`，
state 单次有效并绑定浏览器）、IM 身份的一次性绑定链接（`/api/v1/bind/:token`）与 `/api/v1/me/identities`；
新配置 `auth.loginSources`、`auth.trustedIdentitySources`。成员离职处理（移出、离开共用）在同一事务内删除成员关系、
吊销会话与个人令牌、删除该组织的个人凭据、取消其待处理的审批与提问、把其 agent 转给所有者并标记待重新指派；
新增 `POST /api/v1/orgs/:orgId/agents/:agentId/owner`。迁移 0017 增加 `memberships.source`。
