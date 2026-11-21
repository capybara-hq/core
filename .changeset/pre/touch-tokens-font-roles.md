---
"@capybara-hq/web": minor
"@capybara-hq/plugin-sdk": minor
---

Touch tokens and the code font role. One `@media` block in the generated tokens carries the touch
overrides (system font, larger type, 44 px controls and rows, rounder corners) for a coarse
pointer; `--cb-font-code` keeps Sarasa on code, commands, paths, versions and times. New tokens:
`float-ground`, `float-line`, `shadow-float-touch`, `radius-pill`, `layout-drawer` and the
`touch-*` sizes. The new colors and the shadow join the SDK's overridable theme tokens.
