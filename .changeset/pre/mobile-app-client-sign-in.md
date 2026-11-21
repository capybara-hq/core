---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

Native-app sign-in accepts the mobile app: `POST /api/v1/app-auth/authorize` takes
`client: "mobile"` next to `"desktop"`, and its session's user agent reads
`Capybara Mobile/<version> (<device>)`. The consent page `/apps/authorize` names the app that asked
(desktop or mobile) in its title, hints and errors, and treats an unknown `client` as an invalid
link. The redirect allow-list (`auth.appRedirectUris`) is unchanged.
