---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": minor
"@capybara-hq/web": minor
---

管理后台骨架：部署设置新增 `sandboxLimitOverrides`（按组织覆盖沙箱 cpu 0.25–64 / 内存 256–262144 MB，null 删除）、`customConnectors` 与 `customSkills`（`allow` / `deny`）；新增 `GET /api/v1/admin/overview`（待处理插件、目录申请、组织与账号数）；抽出 `lockEnterpriseAdmins`。CLI 新增 `capybara admin grant|revoke <login>`（企业管理员锁内改、写审计 `via: cli`，不能撤销最后一个）。网页新增企业管理员可见的一级导航「管理」与概览、账号、组织、部署设置四页。
