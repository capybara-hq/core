---
"@capybara-hq/kernel": patch
---

Builtin tool handlers take the device conversation from `rootConversationId` of the call context;
`BuiltinCallContext.sandboxConversationId` is gone and the Platform file reference reads the root from
the context instead of querying it.
