---
"@capybara-hq/plugin-sdk": minor
---

`identity-source@1`：`authorizeUrl` 新增可选参数 `codeChallenge` / `codeChallengeMethod`（`"S256"`），`callback` 新增可选参数
`codeVerifier`——内核为每次第三方登录生成 PKCE 并保存在服务端，插件放进授权地址与换 token 请求即可（向后兼容，
平台不支持 PKCE 时忽略）。注明 `ExternalIdentity.source` 必须等于 `<插件名>:<tenantId>`。
