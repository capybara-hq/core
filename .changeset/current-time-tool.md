---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": minor
---

A builtin `CurrentTime` tool: the current local date-time with its UTC offset, the weekday, the time
zone and the UTC instant. Without `timeZone` it uses the conversation's run context zone (else the
org default, else UTC); an unknown zone is an actionable tool error. Read-only, allowed by default,
and on for new agents with the other default builtins.
