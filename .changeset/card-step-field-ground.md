---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Light cards step toward the middle (layered shell rule 3): `panel` `#F9F8F5`, `panel-2` `#FBFAF8`,
light `fail` `#C42E28`; menus, dialogs, sheets, the palette, tooltips and toasts sit on `raised`; a
new `field` token (white in light, clear in dark) grounds inputs, selects, textareas, steppers, the
segmented track and checkbox / radio boxes. The theme token report gains `field` and the new
contrast and separation pairs. A theme scheme that recolours `panel` without naming `field` keeps
clear fields (`themeSchemeFallbacks`, used by `mergeThemeSchemes` and the kernel's theme stylesheet).
