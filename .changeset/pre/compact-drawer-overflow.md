---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

The compact drawer and the bottom sheets no longer scroll sideways: the drawer's conversation
section and the account sheet's rows kept the sidebar's and an older negative margin (8 px too wide
each), and the drawer is now a vertical-only scroller with the thin scrollbar. The account sheet's
rows share one text column, its labels never wrap and the status line wraps inside its column. A
bottom sheet's close button sits on the rows' edge; the options sheet's notice is styled for every
pointer on the rows' text column. The focus an overlay moves on open draws no ring unless it was
opened from the keyboard.
