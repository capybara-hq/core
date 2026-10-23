---
"@capybara-hq/kernel": patch
---

Channel inbound dedupe keys now have two states: `pending` (60 s) while the enqueue runs and `done`
(24 h) after it. A redelivery that sees `pending` enqueues again with the same job id (a no-op in
BullMQ) and is acked only once that succeeds, so a hanging enqueue that later fails no longer loses
the event; a failed enqueue deletes the key only while it is still `pending`. Webhook requests start
their deadline before the connection lookups, and the webhook runtime cache does not store a plugin
instance fetched across a plugin change.
