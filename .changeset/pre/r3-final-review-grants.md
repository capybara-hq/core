---
"@capybara-hq/kernel": patch
---

An org's excluded device hosts are matched as patterns (`*.example.com` makes `api.example.com`
ungrantable per call, also through an owner's allowlist), and grant issuance re-derives a Full
access escalation's credential consent from the recorded command, so a credential escalation is
never issued as a Full access auto-grant.
