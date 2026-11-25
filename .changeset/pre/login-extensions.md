---
"@capybara-hq/capybara": patch
---

Third-party sign-in is turned on, ordered and trusted in the admin console (Platform → Extensions →
the login extension → Sign-in, and Platform → Settings → Login methods) or through the
`login-sources.*` Platform operations. **Remove `CAPYBARA_AUTH__LOGIN_SOURCES` and
`CAPYBARA_AUTH__TRUSTED_IDENTITY_SOURCES`** (`auth.loginSources` / `auth.trustedIdentitySources`):
startup fails while either is set. Signing in with an unlinked external account now leads to a link
page (username and password) instead of creating an account; self sign-up is opt-in per method.
