---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

An identity source can refuse an account on purpose: the SDK adds `IdentitySourceRefused` and
`isIdentitySourceRefused`, and a login refused that way returns to the sign-in page with
`sso.account_not_allowed` ("This account is not allowed to sign in on this platform…") instead of a
generic provider error. The plugin's message is only logged.
