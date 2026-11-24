---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

The Platform tool's new `extensions.set-enabled` switches an extension that is not a catalog
plugin's (config-declared, or brought by several plugins) on or off in an org. The Extensions page
and Model services switch an extension that needs config on, then let the org configure it.
