---
"@capybara-hq/web": patch
---

Admin pages read cleaner. Models: model names keep a 240 px column, capabilities are plain text
(「工具 · 缓存」) that wraps between items rather than being cut, the price columns are narrowed to their
figures, and the purpose cards (in the admin console and in org settings) share one ActionRow that
saves every changed purpose instead of a 保存 per card; choosing 未设置 / 使用部署默认 clears or restores.
Marketplaces: a refresh error is one sentence in the reader's language with the raw text behind a
原始错误 toggle; the status label sits above its value; every switch is labelled; the Browse and
Sources tabs share one head (description, tab counts, search), so the tabs never move, and the
empty entries list points to 市场源. Extensions: the detail page's 升级 is a button, the bootstrap note
says the plugin comes from npm with its version and checksum pinned, and list rows read 「副本一致 2/2」.
