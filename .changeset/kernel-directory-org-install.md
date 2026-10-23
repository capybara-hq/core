---
"@capybara-hq/kernel": minor
---

组织从企业目录安装：成员浏览与申请（进组织管理员收件箱 `directory_request`），组织管理员安装技能、连接器模板、插件与应用；
条目策略 allow / needs_approval / disabled 生效，needs_approval 经企业管理员批准（授予跨版本有效）后才能安装。应用安装中途失败
按相反顺序撤销本次新建的组件；卸载只移除本次新建且别处不在用的组件，并报告保留项与原因。部署设置 `customConnectors` /
`customSkills` 为 deny 时组织不能自建连接器 / 技能（`directory.custom_disabled`），从目录安装不受影响。后台概览的待处理目录
申请数改为实时计数。新增 `OrgAction` `directory.read` / `directory.request` / `directory.decide`。
