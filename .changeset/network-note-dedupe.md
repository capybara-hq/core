---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A sandboxed `Bash` result blocked at the address layer now carries one instruction about running
outside the sandbox: the kernel's private-address network note replaces the trailing `[sandbox]`
line when it says how to retry escalated (or why that is not possible), and the line keeps only its
retry part when the note states just the fact; without a network note the line is unchanged.
`Grep` and `Glob` also skip `.cache` directories while walking (a docker device's HOME is the
workspace); a path passed explicitly is still searched.
