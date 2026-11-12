---
"@capybara-hq/plugin-sdk": patch
---

A connector template and a custom connector can carry `git: { hosts: [{ host, username }] }`, the git
hosts the connector's credential serves in sandboxes. Adds `GitSourceSchema`, `parseGitSource`,
`validateGitSource` and `GIT_HOST_USERNAMES`; `validateConnectorTemplate` checks the field.
