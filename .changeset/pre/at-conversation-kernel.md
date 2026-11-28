---
"@capybara-hq/kernel": patch
---

A message can reference up to three of the sender's own conversations (`conversationRefs: [{id}]`
on the send, create and first-message bodies): each is read at send time into a bounded English
quoted block (its latest summary and the messages after it, or its last messages) logged in the
`user_message` with `payload.conversationRefs`; refusals are `conversation.reference_unavailable`
and `conversation.reference_self`. A partial index speeds up the latest summary lookup.
