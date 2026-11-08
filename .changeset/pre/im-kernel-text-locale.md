---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

Kernel-generated IM text speaks the person's language, not the org's: `/new`, `/env`, bind prompts
and card-click replies use the sender's platform language, else the bound person's latest web
message language, else the org's; delivered cards and notices use the language recorded on the
conversation's latest user message (in a group thread, the person who triggered the run).
`ChannelSendArgs.locale` carries that language to the extension.
