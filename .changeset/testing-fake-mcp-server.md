---
"@capybara-hq/testing": minor
---

测试工具新增 `startFakeMcpServer({ tools, resources?, requireBearer?, unauthorizedTimes?, onCall?, intercept? })`（SDK 服务端、无状态 Streamable HTTP、127.0.0.1 随机端口；可模拟慢、报错、回显请求头、超大输出、401）与 `FakeMcpRpcError`。
