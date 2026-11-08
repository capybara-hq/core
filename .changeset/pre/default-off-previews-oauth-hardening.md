---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/capybara": patch
---

Connector templates shipped `"defaultEnabled": false` show up correctly in previews. Moving one
from its own scope back to following its plugin lists the orgs it turns off in. A platform update
no longer asks for input on an added template that is shipped off. An update that changes
`defaultEnabled` on a template lists, for each org without a switch of its own, the template
under `needsConfig` (now on) or under the new `turnedOff` (now off, with the agents using it and
the connectors it keeps). OAuth hardening: an auth preset's `tokenTypes` refuses `DPoP`, and a
token endpoint's HTTP 200 with RFC 6749's `temporarily_unavailable` or `server_error` counts as
unavailable instead of a refusal.
