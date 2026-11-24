---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A platform plugin update creates the connectors of the templates it turns on (added ones, and ones
no longer shipped off) in every org where the plugin is on and no connector from the template
exists, inside the update's transaction and without an outbound call (builtin plugins excepted).
A template whose connector plugin is not on in an org is deferred there: the update owes the org's
template connector ensure, which creates it once the plugin is on. Its preview lists them per org
(`connectorOrgs[].created` with display name and starting setup state, `connectorOrgs[].deferred`;
`needsConfig` is gone) and names the orgs where the scope sync will try to install the plugin
(`scopeInstalls`, `failing` with the last failure); all are part of `diffHash`. A template update that clears credentials and leaves a connector ready lists its tools
again through the outbox.
