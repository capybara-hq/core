---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A connector created from a template takes its default slug even when a loaded extension has the
same name: re-creating the Slack connector is `slack` again, not `slack_2`. Connector tools are
`mcp__<slug>__<tool>` and extension tools `plugin__<plugin>__<tool>`, so the names never meet; an
explicit slug already worked this way.
