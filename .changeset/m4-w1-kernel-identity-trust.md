---
"@capybara-hq/kernel": minor
---

第一段身份与安全修复：身份行记建立方式 `identities.linked_via`（bind / sso / directory / local），经 IM 绑定链接建立的
身份（及不受信任租户的通讯录身份）不能直接第三方登录（`sso.identity_not_verified`），本人在登录状态下完成一次后升级；
`auth.trustedIdentitySources` 改为按租户的完整身份源键 `<插件名>:<租户 id>`（只写插件名的配置会被拒绝），第三方登录的
身份源键由内核按 `<插件名>:<tenantId>` 核对；第三方登录由内核生成 PKCE（S256）并交给身份源插件；手动移出 / 离开的通讯录
成员记通讯录排除（`directory_exclusions`），同步不再加回，手动重新加入时清除；离职同一事务内归档其 IM 话题、删除其
「以后都允许」工具授权；匿名访客不能改角色、成为 owner、接受转让、被指派为 agent 负责人、被加入或移出
（`409 member.anonymous_guest`），成员列表带 `anonymous`；绑定确认复核渠道连接与插件启用；通讯录同步在移除前复核
插件仍可同步；权限清单中提供 `directory@1` / `identity-source@1` 标为敏感。迁移 0019。
