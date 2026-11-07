---
"@capybara-hq/capybara": minor
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
"@capybara-hq/plugin-model-fake": minor
---

Tools are on by default: an agent has every builtin, every tool of the extensions enabled in the
org and every tool of the org's connectors, and its definition stores only what it turns off
(`disabledTools`, replacing the enabled `tools` list; migration 0089 rewrites stored agents and
org-made templates to "nothing turned off"). A newly added builtin reaches existing agents; a
connector the org sets up is on for every agent; tools that cannot run now are left out quietly.
The Platform tool's agent operations and `platform.me` use the new shape. `createAgent` in
`@capybara-hq/testing` takes `disabledTools`; model-fake calls a tool on its own only when a
request offers exactly one.
