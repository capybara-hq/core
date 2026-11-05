---
"@capybara-hq/web": patch
---

The home page, a new conversation (`/chat`), a conversation and the inbox are rendered on the
server: they paint complete, with no loading state and no browser read before the first paint.
A conversation opens its stream from the last event the server read.
