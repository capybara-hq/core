---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/testing": minor
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
---

Add the setup guide place `extension-deployment`: a plugin's guide on the super admin's extension
page whose checks get the extension's platform deployment config (`SetupCheckTarget` kind
`extension-deployment`; `SetupCheckArgs.orgId` is now `string | null`, null for this place). The
`fake-push` fixture ships such a guide with the check `fake-push-key`. The kernel serves these guides
and runs their checks on super admin routes (`/api/v1/admin/extensions/:name/guides…`) and the
`extensions.platform-guides`, `extensions.platform-check-status` and `extensions.platform-check`
Platform operations; the web shows them with live check rows on the extension's config tab.
