---
"@capybara-hq/web": patch
---

The web app renders extension UI through `ExtensionSlot` by slot (`conversation.panel`,
`conversation.properties.section`, `conversation.tool-result.card`, `org.page`, `file.preview`)
and reads the kernel's `slot` / `after` contribution fields; a properties section follows the
anchor it names (`context`, `files` or `background`).
