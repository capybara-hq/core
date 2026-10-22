---
"@capybara-hq/kernel": minor
---

M6 终审修正：目录技能装在已有技能上时记下（或清掉）来源条目与版本，退回版本时来源一并退回（`skill_versions`
记每个版本的来源）；插件自己的目录条目 `disabled` 是总开关，含它的应用组织安装与应用包导入审阅都返回
`directory.item_disabled`（点名插件）；应用的可选插件没装到部署 / 版本不满足时跳过它与用它的连接器模板（安装结果
`installed.skipped`），必选插件版本不满足范围 → `directory.not_deployed`，列表与安装按条目版本 `resolved.plugins`
的范围与 `optional` 同一套判定；独立连接器模板的 `pluginVersion` 在导入与组织安装时按加载的版本核对；经应用装到部署
的插件记 `plugin_installs.directory_item_id`；条目删除 / 组织删除时取消挂着的目录申请（审计
`directory.request_cancelled`），安装后一并关闭部署级申请，企业管理员不能批准已删除 / 禁用条目或已删除组织的申请；
成员安装先判角色、申请 disabled 条目得到 not found；连接器预览遵守 `customConnectors: deny`；目录安装的凭据限大小；
清单刷新期间地址被改时丢弃结果；评测 worker 把供应商插件途中撤销（`PluginUnloadedError`）当可重试的
`run.provider_unavailable`（单步回放与评委都重试）；agent 已删除的评测集不能估算 / 启动；供应商 `listModels()` 有
时限，列表视图短时间内跳过刚失败的供应商。
