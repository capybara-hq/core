---
"@capybara-hq/testing": minor
---

测试工具：假 Slack、假 Lark 新增 `socketPeerPorts()`，返回当前长连接的客户端 TCP 端口，双副本测试据此查出持有长连接的副本。
