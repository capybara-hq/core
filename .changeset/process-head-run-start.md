---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`ToolResult.card.badge` (pinned cards only, at most `CARD_BADGE_MAX` = 32 characters): the card's state as its view's badge, recorded on `tool_result.card` (display only). A finished process head shows the pinned summary ("Todos 3/5") after a reload from it, without reading the card's view. A running process head now times the run from `run_started` (its working time, waits for a person left out, as the status bar counts it) on the run's latest block only.
