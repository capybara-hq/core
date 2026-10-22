---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
"@capybara-hq/design": patch
---

成员页与邀请、组织级沙箱限额：创建沙箱时按部署设置 `sandboxLimitOverrides[orgId]` 覆盖 cpu / memoryMb（`effectiveSandboxLimits`，未给的项用部署默认，只对之后新建的沙箱生效）；`GET /api/v1/orgs/:orgId/settings` 增加只读的 `sandboxLimits: { cpu, memoryMb, source }`。网页新增成员页 `/settings/members`（改角色、移出二次确认、转让所有权；匿名访客行控件禁用并带 Badge；生成可复制的一次性邀请链接、撤销）、接受邀请页 `/invite/[token]`（登录后接受或直接注册加入，进入该组织），组织设置页显示沙箱资源（只读）。DataTable 某行菜单项为空时不显示 `⋯`。
