---
"@capybara-hq/plugin-sdk": patch
---

`SetupGuidePlaceInfo` gains `checks`, whether guides of a place may use `::check` lines. It is
false for `device-connection` (a device guide has no target to check): `validateSetupGuide`, and so
`capybara-plugin check` / `pack` and the kernel's import, now refuse a check line there instead of
the web drawing nothing.
