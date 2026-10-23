---
"@capybara-hq/kernel": patch
"@capybara-hq/web": minor
---

管理后台插件页：列表（来源、状态、敏感、副本是否一致，Rail 按状态与来源筛选）、安装向导（上传 tgz 有进度可取消，或 npm 包名加版本；安装确认页按分组展示权限，敏感项高亮并写明原因，网络标「声明，平台不拦截」，迁移警告，升级时显示新增 / 减少的权限；有敏感项须勾选「我已了解敏感项」，依次 install → approve → 可选 enable）、详情（概要：期望状态与各副本状态、启用 / 停用 / 升级 / 卸载，内置与配置声明的插件只读并说明原因；权限：网页批准，审阅过期时提示刷新；配置：部署级配置，启动配置给出的字段只读并显示来源，密钥只能设置或清除）。权限审阅抽成共用组件 `PermissionReview`（组织插件设置页同用）。Web 代理对 `POST /api/v1/admin/plugins/packages/file` 流式透传请求体，上限 `CAPYBARA_WEB_MAX_PACKAGE_BYTES`（默认 50 MiB）。内核 `GET /api/v1/admin/plugins` 新增 `drainSeconds`（停用 / 升级时在途调用的等待时限）。

评审修正：权限分组新增逐项 `entries`（`{value, sensitive, reason?}`，原因码由内核判定），后台视图与审阅结果新增 `addedItems`（`added` 逐项的敏感标记），后台插件视图新增 `warnings`（安装记录包的迁移警告，详情页批准前同样高亮并须确认）；网页只渲染，不再复制敏感规则。上传途中登录过期提示重新登录；详情页收敛中只轮询 `GET /admin/plugins/:name`，出错时保留上一次数据。
