---
"@capybara-hq/design": patch
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/capybara": patch
---

Markdown is parsed with the CommonMark CJK-friendly emphasis amendment
(`micromark-extension-cjk-friendly`): `按**「框架」**来`, `**（注意）**这里` and `~~「旧」~~` render as
strong and strikethrough instead of literal asterisks, in conversations, previews, skill docs and
setup guides.
