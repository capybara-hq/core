---
"@capybara-hq/kernel": patch
---

Breaking: the message body (send, create's `message`, first message) no longer takes
`attachments`, `projectFiles` or `conversationRefs`; references are `tokens` only. Text may be empty
only with a skill, or with uploads and no tokens. `GET /orgs/:orgId/connectors/resources` requires
`connectorId` and lists that one connector's resources (the all-connectors listing is gone).
