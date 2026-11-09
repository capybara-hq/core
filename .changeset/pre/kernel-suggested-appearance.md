---
"@capybara-hq/kernel": minor
---

The kernel applies a plugin's suggested appearance in one step (应用此插件的外观).
`POST /api/v1/admin/catalog/items/:id/appearance` (super admin) sets the plugin's theme as the
platform default theme and each suggested replacement as the platform arrangement's `use`;
`POST /api/v1/orgs/:orgId/extensions/:extension/appearance` (`org.update`, the extension on in the
org) does the same for the org, keeping `personal`. Body `{ dryRun? }`; the answer lists `theme`
(`{ from, to }` or null), `replacements` (`{ slot, from, to }`) and `skipped` (`unknown-slot`,
`not-available`, `not-eligible`). Both writes go through the settings writers in one transaction:
a theme that cannot be set there refuses the whole call with `theme.not_available`; a replacement
that is not available is skipped. The admin item detail and the org extension list (admins) gain
`suggestedAppearance`. Platform operations `plugins.platform-apply-appearance` and
`plugins.apply-appearance` mirror the routes (confirmed every time, never remembered; the dry run
is their card and precheck).
