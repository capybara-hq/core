---
"@capybara-hq/kernel": patch
---

The refresh cookie `cap_rt` is now set on `Path=/` instead of `/api/v1/auth`, so the web tier can
renew a session while rendering pages on the server, and is `SameSite=Lax` instead of `Strict`, so
a link opened from another site (an IM card, an email) still renews the session (the refresh
endpoint stays POST-only behind the CSRF header). Every response that sets or clears session
cookies also clears the legacy-path cookie, and `POST /api/v1/auth/refresh` accepts a `cookie`
header carrying both values (it uses the first one that verifies). A browser that holds only the old
cookie and an expired access token has to sign in once after upgrading.
