---
"@capybara-hq/kernel": minor
---

企业目录给网页用的补充：条目图标只经内核路由给出（`GET /api/v1/orgs/:orgId/directory/:itemId/icon`、`GET /api/v1/admin/directory/items/:id/icon`；`Content-Type` 为 svg / png、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`，没有图标 404 `directory.icon_not_found`）；组织侧条目详情 `GET /api/v1/orgs/:orgId/directory/:itemId`（连接器模板的端点预设、可改路径与认证预设，应用的插件与技能，供安装向导）；清单条目浏览返回 `truncated`（超过上限时）；后台目录条目视图新增 `catalogSourceId`（按来源筛选）。评审修正：图标路由对成员先按策略判定（看不到的 disabled 条目一律 `directory.item_not_found`，不读存储）；后台条目详情新增 `hasIcon`，条目视图新增 `latestCatalogVersion` / `newerInCatalog`（来源清单里的新版本）；目录申请新增 `requestedByName`；组织侧详情只查这一个条目。
