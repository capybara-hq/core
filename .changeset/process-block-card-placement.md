---
"@capybara-hq/plugin-sdk": minor
---

`ToolResult.card` gains `placement` (`output`, `pinned`, `process`) and `text` (Markdown for
surfaces that cannot draw the view, at most `CARD_TEXT_MAX` characters); `ChannelCard` gains the
`progress` kind (one edited progress card per run), rendered by `renderCardAsText` and checked by
`validateChannelCard`.
