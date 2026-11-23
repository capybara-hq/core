---
"@capybara-hq/capybara": patch
---

`capybara secrets rewrap` also rewraps unexpired sealed approval inputs (`platform_sealed_inputs`),
so a resumed Platform call still reads them after the old master key is removed, and prints their
count.
