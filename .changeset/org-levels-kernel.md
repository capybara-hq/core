---
"@capybara-hq/kernel": patch
---

Deployment config fields carry org levels (hidden, read-only, overridable). The platform may leave
required overridable fields empty: the extension still loads, its admin config view lists them in
`orgMustConfigure` and tags each field with `org`.
