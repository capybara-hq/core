---
"@capybara-hq/plugin-sdk": patch
---

The restricted Linux launcher documents a known limitation: `/proc` stays readable, so a restricted
command can read the cmdline of a concurrent Full command of the same uid; Landlock cannot narrow
`/proc` to the command's own tree without breaking ordinary tools. Comment only; the launcher's
digest changes.
