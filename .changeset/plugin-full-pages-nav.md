---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Org admins put plugin pages in the primary navigation: the sidebar and the compact drawer take
`primaryExtensions` (after the built-in entries), the web places each page by the admin's saved
choice, else the plugin's `nav` suggestion (at most 3 primary), and the organization settings get a
Navigation page (导航) to choose. Component queries show their own error messages
(`errors.ui.query_*`).
