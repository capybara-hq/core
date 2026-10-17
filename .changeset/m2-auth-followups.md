---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": minor
---

鉴权与账号收尾：登录限流改为按（登录名, IP）10 次、IP 50 次、单登录名 100 次计数，攻击者无法从自己的 IP 定向锁死已知登录名；改密码、初始化令牌、接受邀请接入独立的限流额度（`reserveScoped`）；改密码成功后同时吊销该账号的全部个人访问令牌；`@Public` 路由不再把 PG / Redis 故障当作匿名放行；Cookie 认证的吊销检查与账号读取合并为一条查询；`GET /admin/accounts` 返回 `next` 游标；部署设置逐键校验；凭邀请注册与初始化在事务外计算密码哈希。CLI `admin create` 在终端上输入密码不再回显。
