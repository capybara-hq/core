---
"@capybara-hq/device": patch
---

The macOS backend reports running outside the sandbox as runtime support only, like the Linux
backends: the owner's `ceiling set --outside-sandbox` switch reaches the deployment in the owner
report. Before, an owner who kept it off saw escalations refused as a runtime limit (and the device
page showed the cloud text), and turning it on took effect only after the program restarted.
