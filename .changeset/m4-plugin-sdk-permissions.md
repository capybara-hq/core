---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
---

- 清单新增可选 `optional`（可选依赖，不得与 provides / requires 重叠）与 `permissions`（secrets / http / tools / hooks / models / storage / network，`validatePermissions` 校验，未知键报错）；`brokered` 能力不得出现在 requires / optional。
- 能力登记表 `CAPABILITIES`（基数 / brokered / orgScoped），`CAPABILITY_CARDINALITY` 改为派生导出；新增预留能力 `object-store`。
- `PluginContext` 新增 `capabilities.get / list`；新增 `PluginPermissionError`、`CapabilityUnavailableError`。内核暂以占位实现拒绝访问（后续任务补全）。
