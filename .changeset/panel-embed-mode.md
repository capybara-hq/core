---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The conversation's right panel keeps an embed mounted across full mode: maximising or restoring
the panel no longer reloads its iframe, so a panel's document and connections survive the switch.
The embed bridge tells a `conversation.panel` embed the panel's mode: `EmbedParentMessage` gains
`panel-mode { full }`, sent right after `init` and on every change, whoever made it (the embed's
own ask, the close control or Esc, the host refusing full mode on a phone). A plugin tool's
`InputRequired` may carry `open` (a `UiOpen` naming a `conversation.panel` of the same extension):
the kernel writes it to `question_asked` after checking it, and the conversation page opens that
panel when the question arrives.
