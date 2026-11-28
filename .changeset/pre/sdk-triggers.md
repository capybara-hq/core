---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
---

Add `ctx.triggers`, the `trigger-source@1` extension point and `permissions.triggers` for event triggers.
Add the observe hook `run.lifecycle` (`RunLifecyclePayload`): the plugin named by a conversation's subject hears when a run starts, waits on a person, finishes or fails, and a directed event's source hears `offer_declined`.
