---
"@capybara-hq/testing": minor
---

测试工具新增 `startFakeOpenApiServer({ apiKey?, apiKeyIn?, echoKey?, specRedirect?, spec? })`（127.0.0.1 随机端口：`/openapi.json` 给出文档或 302，`/v1/*` 实现宠物 CRUD、回显、纯文本、二进制、500 与 302 操作，可要求 header / query 里的 API key，错误正文可回显收到的 key；`requests` 记录每个请求，`setSpec` 运行中替换文档）与默认文档 `defaultFakeOpenApiSpec(base, apiKeyIn?)`。
