---
"@capybara-hq/web": patch
---

Warm routes on touch: a link reads its route's first-paint queries on `pointerdown`, and a sidebar
conversation row does it when it scrolls into view, so the page is often cached when the tap lands.
