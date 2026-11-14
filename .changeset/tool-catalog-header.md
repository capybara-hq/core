---
"@capybara-hq/kernel": patch
---

The tool catalog header in the system prompt now states the rule for every tool, not only for
"more tools": a tool that is not in the model's tool list is not loaded even when the agent's
instructions name it, and calling it returns an error, so `ToolSearch` comes first. Agents that
followed a plugin's or a skill's instruction straight to a catalog tool no longer spend a step on
the error. The not-loaded error and the ToolSearch behaviour are unchanged.
