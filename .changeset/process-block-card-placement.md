---
"@capybara-hq/plugin-sdk": minor
---

`ToolResult.card` gains `placement` (`output`, `pinned`, `process`) and `text` (Markdown for
surfaces that cannot draw the view, at most `CARD_TEXT_MAX` characters); `ChannelCard` gains the
`progress` kind (one edited progress card per run), rendered by `renderCardAsText` and checked by
`validateChannelCard`.
`Channel["features"]` gains `progress`: a plugin that renders the `progress` card natively declares
it; other channels get the card as text, edited in place.
