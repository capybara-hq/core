---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/web": patch
---

Call `context@1` providers at a chat run's start: every provider enabled in the org with a valid
config is asked in parallel (2 s each, outside any transaction), and a `plugin_context` event is
appended when its text changed; a throw, a timeout or text over 32 KB is skipped and logged, and a
provider switched off in the org gets an empty event. The import review shows `provides
context@1` as adding text to the model's context. Tool step contexts now always carry the source,
the owner and the role. `@capybara-hq/testing` gains the `fake-context` fixture.
