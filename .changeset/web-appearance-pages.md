---
"@capybara-hq/web": minor
---

Appearance settings and the admin themes page: 组织设置 › 外观 (the org's themes with their switches,
the platform default locked on; the default theme and 允许成员自选; read only for members), a 外观
section in 偏好设置 (the person's theme, or the org's lock line), the platform default theme in the
deployment settings (内置主题 or a platform `all` theme; a refusal names the orgs where it is off),
and `/admin/themes` with its detail beside the other platform component pages.

Theme names come from the themes themselves on the admin pages; the switch-off, scope, disable,
uninstall and update previews list the orgs whose default a theme is and how many people picked it;
the platform default theme offers no scope or disable action. Pickers use the design
`ThemeSwatchGroup` (one tab stop, arrow keys select).
