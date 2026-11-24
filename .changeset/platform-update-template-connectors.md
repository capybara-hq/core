---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A platform plugin update creates the connectors of the templates it turns on (added ones, and ones
no longer shipped off) in every org where the plugin is on and no connector from the template
exists, inside the update's transaction and without an outbound call. Its preview lists them per
org (`connectorOrgs[].created`, each with the setup state it starts in; `needsConfig` is gone) and
names the orgs where the scope sync will now install the plugin (`scopeInstalls`); both are part of
`diffHash`. A template update that clears credentials and leaves a connector ready lists its tools
again through the outbox.
