---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
---

模型、价格与用途映射页。内核新增 `GET /api/v1/admin/models`（企业管理员）：每个模型供应商一项 `{provider, plugin, status, error?, models}`，列模型失败的供应商标 `error`（只给内核的英文说明，不透出上游原文），不影响其他供应商；一并返回价格表与币种。`ProviderRegistry` 新增 `listWithStatus()`。网页新增后台「模型」页 `/admin/models`（供应商与模型：能力、上下文长度、每百万 token 价格行内编辑 / 清除；用途默认映射：插件声明的用途旁注「插件调用模型尚未开放」，`eval` 未映射时提示评测不能开评委）与组织设置「模型用途」页 `/settings/models`（显示部署默认，组织管理员可覆盖或恢复默认；评测向导的评委链接指向这里）。用途的模型参数复用 `ModelParams`。
