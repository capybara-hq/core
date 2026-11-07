---
"@capybara-hq/kernel": patch
---

Tool policies can be keyed per call: a builtin's `callPolicy` derives a policy key from the input
(`Platform:<operation>`), which agent policies, grants and approvals use. An approval stores its
kernel-rendered summary and the scopes the person may choose (`approval.scope_not_allowed` for any
other), and runs only with the exact input it showed.
