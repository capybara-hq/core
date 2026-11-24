---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Connectors can be created without listing their tools (`ConnectorsService.createDeferredIn`, for
installs, scope syncs and upgrades): the row is written with no outbound call and the tool list
follows through the outbox (`connector-tools-list` on the new `cap-connector-tools` queue, shown on
the health overview). A `needs_config` connector gets the job when an org admin saves its missing
input (its first OAuth client can now be saved on the connector), a personal one on a member's first
credential. Agents get no tools from a `needs_config` connector, and the git gateway tells a member
that an org admin must configure the connector instead of asking them to reconnect.
