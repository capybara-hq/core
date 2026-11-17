---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

Org admins set a connector's default git push policy (allow / ask / deny) on its settings page, the
new `PUT …/connectors/:connectorId/git-push-policy` route or the Platform operation
`connectors.set-git-push-policy` (which may only tighten it). Members see their standing push
decisions per repository on the connector's permissions sheet and can clear them.
