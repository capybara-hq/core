---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-tools": patch
"@capybara-hq/kernel": patch
---

The client stylesheet rule is one function in the SDK: `clientCssProblem` (with `wrapClientCss`, the
`@layer extensions` wrap the packer stores). `capybara-plugin pack` runs it on the file as it stores
it and the kernel's import runs it on the stored bytes, so a plugin that packs cleanly imports
cleanly: a broken `url(` fragment, a bad url token or a brace that would end the
`@layer extensions` block early is refused at pack time (`client-css-remote`), not only at import.
The packer no longer loads the kernel for this.
