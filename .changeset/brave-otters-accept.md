---
"@capybara-hq/testing": minor
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": minor
---

M1 身份与组织收尾：双副本工具 `createDualReplicaHarness` 新增 `config` 选项，把额外的内核配置（如 `auth.cookieSecure`、`auth.setupToken`）深合并进两个副本，经 IPC 传递、不进 argv / env；新增 M1 双副本端到端验收（初始化 → 组织 → 邀请注册 → 角色鉴权 → 跨副本即时生效的角色变更 / 登出 / 登录限流 → 并发初始化）。新增技能 `writing-kernel-api`，`writing-plugins` 补充插件路由匹配语义，README 快速开始补初始化步骤。
