---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

评测快照读出时规范化改名前（D17）的 `{ kind: "app" }` 工具引用（`readSnapshot`），整轮回放不再丢掉连接器工具。迁移检查：带豁免注释的 `DO` 块原因一律必填（动态 `EXECUTE` 检查看不见）。网页 i18n 键 `wizard.openApp` → `wizard.openConnector`。
