---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/capybara": patch
---

An `oauth_code` auth preset may set `authorizationParams`, extra query parameters of the
authorize request (Google's `access_type: "offline"` and `prompt: "consent"`, Slack's `team`):
at most 10, lowercase names, plain printable values, never a secret. The kernel appends them after
its own parameters on every connect and reconnect, never on a token request. Names the kernel owns
or that would change the callback or the token exchange (`OAUTH_RESERVED_AUTHORIZATION_PARAMS`)
are refused there and in the query of a manual `authorizationUrl`. A template update that changes
only `authorizationParams` keeps members' connections. A member whose access token dies without a
refresh token is now asked to reconnect instead of told the authorization server is unavailable.
