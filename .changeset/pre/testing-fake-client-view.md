---
"@capybara-hq/testing": patch
---

The `fake-client` fixture's `hud` reads its server view's data from `useView().view` (it read the
view state itself and always showed `hud -`), and `fake.css` also decorates the composer's buttons
(`[data-cap-part~="composer"] [data-cap-part~="button"]`).
