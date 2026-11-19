---
"@capybara-hq/kernel": patch
---

Project knowledge reads (AGENTS.md, SKILL.md) on cloud instance-boundary devices (Docker, E2B)
work again: a kernel read on such a device is sent with the instance scope the providers run,
and the covering-path check still confines its path. A runtime that refuses a kernel read's scope
now records the project as unreadable with a clear reason, and the run goes on.
