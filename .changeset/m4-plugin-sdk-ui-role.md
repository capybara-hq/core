---
"@capybara-hq/plugin-sdk": minor
---

插件界面参数带上调用者角色：`UiRenderArgs`（及继承它的 `UiActionArgs`）与 `EmbedClaims` 新增
`role: UiRole`（`"owner" | "admin" | "member" | "guest"`）。`place: "page"` 的贡献只给 member 以上，
由内核把关；插件可按 `role` 再收紧。
