---
"@capybara-hq/testing": patch
---

`startFakeChannelServer` 的假 OAuth 支持 PKCE：授权时带 `code_challenge`（S256）的，`/oauth/token` 须带对应的
`codeVerifier`，否则 `invalid_grant`。
