---
"@capybara-hq/web": patch
---

A setup guide section has 让智能体协助 / Ask an agent: it opens a new conversation with a drafted
message in the composer (not sent) that names the guide (plugin, catalog item, guide id, place,
audience) and its target by id, so the agent can follow it with the Platform `setup` operations.
The draft carries names and ids only, never a config value; the platform preview has no entry. The
new conversation reads `?draft=` once into the composer, on phones without focusing it.
