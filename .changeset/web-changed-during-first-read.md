---
"@capybara-hq/web": patch
---

A conversation's `changed` frame that arrives while the page's first read of that part is still
on its way now reads it again. The properties panel could miss a background task started right
after the page read the empty list, until the task finished.
