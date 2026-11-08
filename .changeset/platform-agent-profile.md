---
"@capybara-hq/kernel": patch
---

Platform tool: `agents.update-profile` sets an agent's preset avatar (or none) and its quick
actions, confirmed like `agents.update` (rememberable only on your own private agent).
`platform.me` returns the agent's profile. The last `later` exclusion is gone: the category is
removed and `check:platform-ops` fails any `later` entry.
