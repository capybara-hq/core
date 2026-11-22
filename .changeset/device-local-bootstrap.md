---
"@capybara-hq/capybara": patch
---

The image pins `device-local` (`@capybara-hq/plugin-device-local@0.1.0-rc.1`) as a bootstrap
preinstall with scope `all`: local devices work again, on in every organization, and an org admin
may switch them off. Local devices made before the upgrade are deleted and must be reconnected;
upgrade `capybara-device` together with the kernel.
