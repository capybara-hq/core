---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-tools": patch
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": patch
---

Setup guides: a `connector-template` guide names one or more templates (`templates: string[]`,
replacing `template`; a template still has at most one guide), so one guide can serve several
templates of a plugin. `{{templateId}}` / `{{templateName}}` render the template the guide is shown
for: the target connector's, the new `templateId` query parameter of the guide routes, or the
guide's only template (else unresolved with reason `no_template`). The `extension-deployment`
place now offers `{{signInCallbackUrl}}` (`<publicUrl>/api/v1/auth/sso/<plugin>/callback`), built
from the same path constant as the SSO flow's redirect URI. `capybara-plugin pack` / `check` refuse a guide naming
a scanned template the plugin lacks.
