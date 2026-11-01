---
"@capybara-hq/web": patch
---

The agent pages (the list, a new agent and an agent), the skill library (the list and a skill),
the connector pages (the list, a connector and the install wizard, whose `?template=` item is read
with the page), the org catalog (the list, an item and the install wizard) and the channel pages
(the list, a new connection, whose `?agentId=&returnTo=` preset is read with the page, and a
connection) are rendered on the server: they paint complete, with the agent form's models,
connectors, skills, sub-agent options and channels, and no browser read before the first paint.
