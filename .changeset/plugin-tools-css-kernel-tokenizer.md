---
"@capybara-hq/plugin-tools": patch
"@capybara-hq/kernel": patch
---

`capybara-plugin pack` checks a client stylesheet with the kernel's import check (`clientCssProblem`,
now exported by `@capybara-hq/kernel`) on the file as it stores it, instead of a looser mirror: a
broken `url(` fragment, a bad url token or a brace that would end the `@layer extensions` block
early is refused at pack time (`client-css-remote`), so a plugin that packs cleanly imports cleanly.
