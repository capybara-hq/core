---
"@capybara-hq/plugin-lark": minor
---

Lark 插件新增网页登录（`identity-source@1`，OAuth 授权码 + PKCE S256，v2 OAuth 换 token、用户信息、核对租户；
部署级 `appId` / `appSecret`）与通讯录（`directory@1`，根部门 + 递归子部门逐页列出直属成员，离职 / 冻结 / 主动退出
为不在职，未激活 / 未加入不同步，限流有 30 秒等待预算；组织级 `appId` / `appSecret`，`configured()`）。身份键
`lark:<tenant_key>` + `open_id`，与机器人一致；同一租户的机器人或通讯录用了与登录不同的应用时报错（open_id 按应用区分）。
