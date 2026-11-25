---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Questions can be answered with buttons. `InputForm` gains `body` (longer text under a short title)
and, on its single field, `choices` (labelled values). When that field is required and a single
choice (a `boolean`, or a string `enum` without `multiSelect` / `allowOther`), it renders as one
button per choice, the first primary, and pressing one answers at once. Examples are a confirm
(完成 / 取消) and a one-value wait (结束等待). `validateInputForm` checks the rule, and the
kernel keeps `body` and `choices` in `question_asked`. The conversation's question card shows the
body. When the plugin tool's `InputRequired` names a panel (`open`), the card also offers an action
that opens that panel.
