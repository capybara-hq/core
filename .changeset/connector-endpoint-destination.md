---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

Editing a template connector's endpoint now treats a change to any editable field but `headers` as
a new destination (not only `url`): OAuth tokens and members' own credentials are cleared, and so is
an OAuth client registered there (`dcr`) or whose endpoints MCP discovery found at the old url (the
connector turns `needs_config` until an org admin saves the client again). A manual client with
fixed endpoints and the org's static credential stay. The `connector.updated` audit names what was
cleared (`credentialsCleared`). Connecting a connector without its OAuth client now says that an
organization admin must configure it. The fake connector fixture's endpoint takes an optional
`apiUrl`.
