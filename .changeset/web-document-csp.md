---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Every page document carries a content security policy with a fresh nonce per request:
`script-src 'self' 'nonce-<n>'; object-src 'none'; base-uri 'none'` (development adds
`'unsafe-eval'`). Next puts the nonce on its own scripts; `/api`, `/plugin-ui`, `/_next` and the
object-store proxy keep their own headers.
