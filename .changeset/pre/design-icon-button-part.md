---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

`IconButton` carries the `button` UI part (`button button.primary` for the primary variant) like
`Button`, so plugin CSS on `[data-cap-part~="button"]` reaches every button, the composer's send and
stop among them.
