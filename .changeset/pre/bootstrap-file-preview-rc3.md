---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The file-preview bootstrap pin moves to rc.3 (capybara-hq/plugins#129): the plugin drops its `html` previewer, since the kernel's built-in previewer renders HTML. The marketplace pin and the sandbox-docker build contexts move to capybara-hq/plugins 84a5307; every other pin already matches that commit's marketplace.
