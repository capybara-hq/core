---
"@capybara-hq/kernel": minor
---

内核 API 接入身份认证：全局默认拒绝的 AuthGuard（Bearer API 令牌 / 会话 Cookie + CSRF 头）、`POST /api/v1/auth/{login,refresh,logout}`、`GET /api/v1/me`、`PUT /api/v1/me/password`，登录尝试按登录名与 IP 原子限流。新增配置 `auth.cookieSecure`（默认 true）与 `http.trustProxy`（false / 跳数 / 受信代理 CIDR 列表，默认 false）。
