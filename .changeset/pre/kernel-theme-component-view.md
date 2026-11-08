---
"@capybara-hq/kernel": minor
---

The admin component list gives each theme its name and swatches (`theme: { name, swatches }`), and
an org's theme switch-off preview lists whether it is the org's default and how many members picked
it (`preview.themes`), so the pickers and dialogs show them.

An org owner's update preview names the orgs whose default a removed theme is (in `orgNames`) and
counts only the owner org's own people in `pickedBy`.
