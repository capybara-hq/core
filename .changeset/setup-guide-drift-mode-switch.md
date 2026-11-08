---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Switching a channel connection's inbound mode no longer clears the setup guide update notice: the
mode switch moves the recorded guide on only when it shows no drift, so the notice stays until a
person confirms 「我已更新应用」. The 接入指南 says why a variable has no value (saving the
channel on 新建渠道, or the public address and webhook address a super admin sets in the
deployment settings), and the guide read is keyed by the plugin version so an upgrade shows the
new manifest.
