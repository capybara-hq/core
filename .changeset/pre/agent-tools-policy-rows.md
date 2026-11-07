---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

The agent page's Tools section puts each tool's policy on its row (a new `ToolPolicyList`): the
built-in tools stay in the card, and each extension or connector is one row with a summary that
opens a Sheet with its tools, select-all and a filter. A connector can now be taken tool by tool.
The connector detail's tools carry their display `title`.
