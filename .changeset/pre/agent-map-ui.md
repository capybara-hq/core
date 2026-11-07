---
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

The agent map opens one sub-agent's summary (latest text, task, background tasks, tool calls newest
first, Stop while it runs) and its read-only transcript; an `Agent` call block names the child's
current tool and opens it in the map. A sub-agent's reports and its end show in the parent as notice
lines, and a parent's messages in a sub-agent's transcript as bubbles labelled with the sender.
