---
"@capybara-hq/plugin-sdk": minor
---

插件界面贡献的 SDK 契约：`ToolResult.display`（工具调用的中英文一句话说明）与 `validateToolDisplay`；清单新增 `ui`（`UiContribution`：对话标签 / 组织页面，view / embed）与 `permissions.ui`（`views` / `embeds`），`definePlugin` 交叉核对 id、embed 的 `/ui/` 路径与 GET 路由声明（`validateUiContributions`）；渲染 schema `UiView` / `UiBlock`、上限 `UI_LIMITS` 与 `validateUiView`（链接与图片只允许 http(s)）；`ctx.ui`（`view` / `action` / `invalidate` / `verifyEmbedToken`，内核运行时为占位，后续实现）；嵌入协议 `EMBED_PROTOCOL`、`EmbedClaims`、父子消息类型与 `parseEmbedChildMessage`。`check:plugin-permissions` 新增规则 `perm-ui`。
