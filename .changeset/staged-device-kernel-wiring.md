---
"@capybara-hq/kernel": patch
---

The staged (protocol 3) device path is wired on the kernel side, still dormant behind the protocol
gate: a staged hello and policy frame are recorded with their connection id, a revoked machine gets
a protocol 3 `stop` fenced to that machine and its operations a `revokeOperation`, the staged
`@local` provider queues no broad kill and registers its instance binder, a local narrowing goes as
a v3 `policy` op carrying an owner-ceiling narrowing (audited once), and only the gateway's own
marker says a request was not sent.
