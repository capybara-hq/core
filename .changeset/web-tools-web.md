---
"@capybara-hq/web": minor
---

Web: the org extensions page has a "Default providers" section for extension points several
enabled extensions provide (`web-search`, `web-fetch`), with a "not selected" state while none is
chosen; the agent form offers the builtin `WebSearch` and `WebFetch` tools (not checked by
default) when the org has a provider for them, and keeps them listed for an agent that already
selected them; `usage` events with `purpose: "web_fetch"` don't count as the conversation's
context.
