---
"@capybara-hq/plugin-sdk": minor
---

Question cards can be skipped and say a text reply works. `ChannelCard` kind `question` gains the
state `skipped` (the person sent a message instead of answering) and `textReply?: "plain" |
"mention"` (pending cards: the person may answer by replying in the DM, or in the group thread
mentioning the bot). `questionRenderableInline(form, { textReply })` accepts a field with
`allowOther` when the card has `textReply` (draw no Other button: Other is a plain reply), also for
multi-select. `renderCardAsText` writes the hint line and the skipped label; channel plugins use
`questionTextReplyHint` and `questionStateLabel` for the same copy (an unknown state returns itself).
