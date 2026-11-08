---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Single-provider extension points, follow-ups. An upgrade of an enabled extension whose new version
newly provides a single-provider point another extension holds installs the new version disabled
and says why (`leftDisabled`, the import / update / bootstrap results) instead of silently taking
the point over. A required bootstrap entry whose point is held fails the bootstrap ("disable
<other> and run the bootstrap again"). A point a required plugin holds cannot be replaced: 409
`extension.single_provider_required`, and the admin console says so. Refusals name the provider
actually loaded. When the elected provider fails to load, the admin console warns that the point
has no running provider.

Upgrading: a deployment that already had two enabled providers of one point (from before the
one-provider rule) could switch providers on the rolling deploy, because migration 0097 picks the
one enabled first by the audit. Migration 0098 prefers the provider replicas are running (a
`loaded` replica status row, most recent heartbeat); with no such row the 0097 order stays, and the
provider may change: check the admin console after the upgrade and disable the one you don't want.
