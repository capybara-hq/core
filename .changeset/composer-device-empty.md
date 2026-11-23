---
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

The new conversation's device picker no longer opens an empty list: with no device but a device
provider on, it reads "No device" and offers only New device (the Devices page's dialog); with no
way to create one it is gone. The org Models page shows a locked model service's state on a
disabled switch, as the Extensions page does.
