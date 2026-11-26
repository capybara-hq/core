---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A device provider's own `ToolError` answer is a definite outcome, not an unknown one (#903): a read
(`readFile`, `stat`, `list`, `scan`) answered with any `ToolError`, and an effectful operation
answered with an ordinary one (`kind: "error"`) on its first dispatch, complete their recorded
intent with the failure and reach the model as the provider wrote them; the same identity replays
that answer. A transport loss, an `unavailable` answer to an effectful operation and any answer to
a reconciled effectful operation stay unknown. A background start answered with a `ToolError` is
refused with the kernel's reason.
