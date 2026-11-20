---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/design": patch
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Desktop onboarding: `GET /api/v1/meta` lists `appRedirectUris` (`auth.appRedirectUris` while app
sign-in is available, else empty), so the desktop app can say before opening the browser that the
platform does not allow it; the app token exchange answers `auth.account_disabled` (403) for an
account that is not active instead of `app_auth.code_invalid`. `chrome@1.setAppearance` also
carries the page's seven main color tokens (only when all are plain colors) and `singleScheme`
under a single-scheme UI theme; the SDK gains `ChromeCapabilityV1`, `ShellChromeTokens` and
`SHELL_CAPABILITY_KEYS.chrome`.
