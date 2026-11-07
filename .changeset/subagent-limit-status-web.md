---
"@capybara-hq/web": patch
---

A sub-agent that ended on a limit (token budget, step or time limit) reads 「已达上限」 / "Limit
reached" in amber in the agent map, the stream and its legend, not as a red failure. The admin org
limits dialog shows each deployment default as the empty field's placeholder and the orgs table
「默认（5,000,000）」; sub-agent dispatches and tokens get a 「不限制」 checkbox.
