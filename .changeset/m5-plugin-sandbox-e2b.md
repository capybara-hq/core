---
"@capybara-hq/plugin-sandbox-e2b": minor
"@capybara-hq/testing": minor
---

新插件 `@capybara-hq/plugin-sandbox-e2b`（`sandbox@1`，M5 T10）：每个对话一个 E2B 沙箱（E2B 云或自托管）。部署配置
`apiKey`（密钥）、`template`、`apiUrl`、`domain`、`timeoutSeconds`（默认 3600，到点自动暂停而不删除）、`domainAllowlist`、
`allowOpenEgress`（默认 false）。`suspend` → pause，`resume` → connect（404 → gone），同名 `create` 先按元数据清掉旧实例，
`destroyByName` 按元数据列出删除。`exec` 走 envd 的进程流，超时或中止时按会话杀掉命令及其子进程；文件读写以沙箱用户在
沙箱里执行（上传只进 root 专用中转目录），`/skills` 由 root 写、沙箱用户只读。建沙箱带 `secure: true`，create / connect
没给 envd 访问令牌时拒绝连接（fail closed）。命令经 `timeout -s KILL` 在沙箱里也有时限；`killAll` 杀掉前任遗留的命令。出站 none / allowlist（E2B `allowOut` 域名 +
`denyOut` 全部）/ open。自写极简客户端，不依赖官方 SDK。`@capybara-hq/testing` 新增 `startFakeE2B`（控制面 API + envd 的假服务；`withholdAccessToken` 模拟拿不到令牌）。
