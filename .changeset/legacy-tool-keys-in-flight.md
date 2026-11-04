---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

A tool call logged under a release-candidate builtin key (`sandbox_bash`, `skill_load`, ...) that was
still open when the tool names changed runs as the renamed tool with its parameters translated, and
its result keeps the logged key. An approval of such a call given after the upgrade lets it run
without asking again, and an `agent` call whose sub-agent was dispatched before the upgrade gets its
result when the sub-agent finishes. A call to an old key that the request never offered gets the
unknown-tool error plus a hint naming the new tool and its parameters.
`GET …/conversations/:id/tools` answers an old builtin key as its current tool with `aliasOf`, so
the conversation page shows old `agent` calls as sub-agent rows and old builtin calls with their
current label.
