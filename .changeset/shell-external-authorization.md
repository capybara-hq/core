---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Native shells finish connector OAuth and login-method linking in the system browser: the connect
and link starts take `handoff: { returnScheme? }` and answer a single-use handoff URL; the web page
`/handoff/<ticket>` redeems it in the person's signed-in browser (`POST /api/v1/auth/handoffs/redeem`)
and the flow comes back to `/handoff/done`, which links back into the app.
