---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

`bootstrap.json` entries that are optional preinstalls (neither `required` nor `builtin`) accept
`scope: "all"`: the catalog item is created on in every org and an org admin may switch it off.
The scope is read only at the first import.
