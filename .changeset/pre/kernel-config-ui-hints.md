---
"@capybara-hq/kernel": patch
---

Extension config forms in the kernel: deployment, org and channel connection JSON Schemas carry the
config UI hints (`x-ui`); invalid hints never fail a load, they are stripped from the schema with
one warning per extension version and a note in the replica status. Config issues gain `segments`
(the unjoined path) and `messageKey` (a custom issue naming a root `x-ui.messages` key). An
unloaded install record's deployment config view returns the package's
`extension.configSchemas.deployment` as `schema` (`validated: false`).
