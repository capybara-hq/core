---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/capybara": patch
---

OAuth connectors work with Slack-like token endpoints. A token response with `token_type: "user"`
(Slack's `oauth.v2.user.access`) is accepted and sent as `Authorization: Bearer`, like `Bearer`;
an `oauth_code` / `oauth_client` auth preset may list more accepted types in `tokenTypes`, and
any other type is still refused (`unsupported_token_type`). A token endpoint error reported as
HTTP 200 with `{ "ok": false, "error": … }` (or an `error` and no token) is a refusal with that
code, like a 400: `invalid_refresh_token`, `token_revoked` and `token_expired` join `invalid_grant`
in deleting the person's connection so they are asked to reconnect, transient codes such as
`ratelimited` count as unavailable, and other codes keep the credential.
