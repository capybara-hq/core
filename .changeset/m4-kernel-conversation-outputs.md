---
"@capybara-hq/kernel": minor
---

新增 `GET /api/v1/orgs/:orgId/conversations/:id/outputs/:outputId?offset=&limit=`：网页读工具输出存档的全文（按字符分页，单页至多 20 万字符，`next` 为下一页起点）。会话可见性与会话事件流相同，不可见 → 404 `conversation.not_found`；存档不属于该会话或已过期 → 404 新错误码 `conversation.output_not_found`。服务令牌 403。
