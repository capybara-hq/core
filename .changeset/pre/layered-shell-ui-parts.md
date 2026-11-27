---
"@capybara-hq/plugin-sdk": patch
---

Removes the `status-bar` UI part: the shell no longer draws a status bar. The theme token values
follow the layered shell: a darker `sidebar` ground (light `#EDECE7`, dark `#171716`), a lighter
light `bg` paper (`#FDFDFC`), dark `hover` and `sidebar-active` as white overlays, light `hover`
at 0.045 and dark `selected` `#21211F`.
