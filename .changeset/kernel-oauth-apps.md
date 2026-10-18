---
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
---

应用 OAuth 认证：认证方式新增 `oauth_code`（个人凭据；MCP OAuth 发现 RFC 9728 → RFC 8414 或手填端点；RFC 7591 动态注册或手填 client，不支持 DCR 时 `app.connect_failed` 带 `dcr_unsupported`）与 `oauth_client`（组织凭据，客户端凭据流，token 缓存于凭据存储）。新增 `POST /api/v1/orgs/:orgId/apps/:appId/connect`（授权码 + PKCE S256，state 存 Redis 10 分钟、单次有效，回调须来自发起连接的浏览器）与公开路由 `GET /api/v1/oauth/callback`；access token 过期前 60 秒或收到 401 时在 `capk:oauth-refresh:*` 锁内刷新（不并发刷新），refresh 被拒 → 凭据删除并触发「需要连接」。OAuth 应用要求配置 `http.publicUrl`；新增配置 `tools.oauthAllowInsecureLoopback`（仅开发 / 测试）。测试工具：新增 `startFakeOAuthServer`，`startFakeMcpServer` 支持 `verifyBearer` 与 `protectedResource`（受保护资源元数据）。
