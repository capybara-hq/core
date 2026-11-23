---
"@capybara-hq/plugin-sdk": patch
---

A connector template's `description` may be `{ zh, en }` as well as a string
(`ConnectorTemplateFile.description: string | LocalizedName`); the 1024-character limit applies to
each text. A plain string stays valid and is shown in both languages. The connector template JSON
Schema follows.
