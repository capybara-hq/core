---
"@capybara-hq/kernel": minor
---

`tool_search` 与组织设置（spec 5.5，D11）：新增 `GET|PATCH /api/v1/orgs/:orgId/settings`（成员可读，PATCH 需 `org.update`，审计 `org.settings_updated`），设置 `{ toolSearch: "on" | "off" }`，默认 `on`，存于 `orgs.settings`（读取宽松，未知键保留）。组织开启且 agent 的可用工具数 > `tools.searchThresholdTools` 或工具定义估算 > `tools.searchThresholdTokens` 时，注册表自动加入内置工具 `tool_search {query, limit?: 1–10}`：请求里只放内置工具与已加载工具的完整定义（已加载工具按首次加载顺序追加在后），其余工具以目录（`- <key>: <描述首行>`，按 key 排序）放进 system 第二个块；`tool_search` 按关键词确定性评分返回完整定义，结果事件 `tool_result.loadedTools` 记下加载的工具，已加载集合只由日志还原。`model_call.request` 新增 `catalog`（目录工具的 key 与指纹，定义同样存进 `tool_specs`）。调用目录里尚未加载的工具返回 `Tool "<key>" is not loaded. Call tool_search first …`，不自动加载。
