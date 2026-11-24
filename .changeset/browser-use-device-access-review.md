---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/plugin-tools": patch
---

`permissions.deviceAccess` is reviewed: each declared device service is a sensitive, blocking
permission key (`permissions.deviceaccess:<service>`), so an extension declaring it, or an upgrade
adding a service, waits for approval; the review lists the services in a "Device services" group.
`capybara-plugin check` reports `ctx.deviceAccess` used without `permissions.deviceAccess`
(`perm-device-access`).
