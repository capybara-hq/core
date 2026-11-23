---
"@capybara-hq/capybara": patch
---

The web app has one org config form per extension: the overridable deployment fields (following
the platform or the org's own copy). The org-config section, Save and enable and the install
wizard's extension step are gone, and the platform's config form tags each field `Platform only`
or `Org can override`.
