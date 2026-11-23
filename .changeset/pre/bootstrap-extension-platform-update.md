---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The bootstrap step now moves the platform version of a pinned plugin with an extension along with
its extension: once the extension runs the raised pin, a platform version that came from the
bootstrap and is lower is applied through the platform plugin update, so the plugin's skills,
connector templates, themes and org installs follow it. A platform version the super admin moved to
is kept, a disabled plugin is left for the super admin, and a platform an earlier run left behind
is caught up.
