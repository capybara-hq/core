---
"@capybara-hq/plugin-sdk": patch
---

`nav@1` (shell capabilities) gains the Duo strip's pill action, account and side: `set` takes a
required `action` and an optional `account`, the handle has `onAction`, `onAccount` and `side`, the
items may include `search`, and `menu` / `NavMenuV1` / `onMenu` are removed (the strip has no menu
button any more). The mobile app's nav@1 must ship together with this web: an older shell rejects
the new state.
