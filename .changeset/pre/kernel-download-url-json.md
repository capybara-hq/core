---
"@capybara-hq/kernel": minor
---

The attachment and artifact download routes take `?as=url`: under the same session and org checks
they answer `{ url }` (the presigned location the 302 would send, `Cache-Control: private,
no-store`), so the web can hand a native shell's system browser a cookie-free download URL.
