---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

After an environment's files are reset (on the environments page, by the Platform operation, or
after they were lost), each conversation of the environment now learns on its next sandbox command
that the files were reset, instead of being told the instance restarted with its files kept. The
kernel counts resets itself, since a provider may give the new file system the old id. A connected
machine's lost directory recreated by a new `capybara-device login` counts as a reset too. So does a
new login from another machine, or from another directory or mode on the same machine.
