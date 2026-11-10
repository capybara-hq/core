---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-client": minor
"@capybara-hq/design": patch
"@capybara-hq/web": patch
---

New UI parts for theme plugins: `message.user.bubble`, `code-block`, `menu`, `segmented`,
`stat-card`, `switch` (`aria-checked`) with `switch.knob`, `org-avatar` and `agent-chip`
(`aria-pressed`); `message.assistant` promises `aria-busy` while its text streams, and the web sets
it on the live reply. `UiPartState` gains `aria-checked` and `aria-pressed`.
