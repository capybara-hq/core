---
"@capybara-hq/testing": patch
---

`startFakeOAuthServer` takes `dialect: "slack"` (answers like Slack's `oauth.v2.user.access`:
`ok: true`, `token_type: "user"`, every error as HTTP 200 `{ ok: false, error }` with
`invalid_code` / `invalid_refresh_token` / `invalid_client_id`) and `tokenType`; each
`tokenRequests` entry records the `error` it answered.
