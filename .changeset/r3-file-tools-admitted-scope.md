---
"@capybara-hq/kernel": patch
---

Read, Write, Edit, Glob, Grep, Deliver and project skill reads are bounded by the operation's
admitted scope (project roots plus directory grants, protected paths excluded), as `Bash` is, and
never by the device's outside-sandbox setting. With outside-sandbox off (a new install's default)
they no longer refuse an os-user project outside the workspace or an approved or auto-granted
directory crossing. The fixed roots bound the file tools only on the legacy route in sandbox mode.
