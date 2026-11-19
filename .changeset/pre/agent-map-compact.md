---
"@capybara-hq/web": patch
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

The agent map is compact: every agent is a 44 px row (was a 62 px bordered card) 336 wide, siblings
4 px apart (was 8), no box per row (hover and the open agent get a ground), the root a quiet card
level with its first child instead of centred on a long column, and the connectors meet each row's
centre. On a row's meta line only the model name gives way; time and tokens always stay whole.
The count line, legend and background task rows are tighter, and the agent's summary dialog has two
meta lines (spawner, time and tokens on one) and tighter body and footer padding.
