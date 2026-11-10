---
"@capybara-hq/kernel": patch
---

A bootstrap import of a plugin with client code (`extension.client`) is refused with
`client.invalid`, naming the plugin and saying to take it out of `bootstrap.json`: client files are
kept in object storage, which a bootstrap run may not have.
