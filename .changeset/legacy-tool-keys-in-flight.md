---
"@capybara-hq/kernel": patch
---

A tool call logged under a release-candidate builtin key (`sandbox_bash`, `skill_load`, ...) that was
still open when the tool names changed runs as the renamed tool with its parameters translated, and
its result keeps the logged key. A call to an old key that the request never offered gets the
unknown-tool error plus a hint naming the new tool and its parameters.
