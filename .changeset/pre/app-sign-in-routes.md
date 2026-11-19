---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Native apps sign in through the browser: `POST /api/v1/app-auth/authorize` (a signed-in person's
consent) issues a one-time code bound to a PKCE S256 challenge and a redirect URI from the new
`auth.appRedirectUris` (default `["capybara://auth/callback"]`), and `POST /api/v1/app-auth/token`
exchanges it once, within 60 s, for an ordinary web session of the app's own.
