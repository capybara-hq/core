---
"@capybara-hq/device": patch
---

`capybara-device`: on macOS, a restricted command whose write root contains an owner-denied path
(a project bound at the home directory, an approved `cd ~`) can no longer write the denied secret
paths (`~/.ssh`, `~/.aws`, `~/.netrc`, …) or the device's own state directory: their files cannot
be written, created, renamed or deleted, and the directories cannot be moved, removed or replaced
by a symbolic link. Before, those paths were only hidden from reads. On Linux such a grant stays
refused, and the refusal now names the root and the denied path and says to run from a narrower
directory.

A `capybara-device` newer than its deployment no longer tells the person to upgrade the program
when the deployment refuses it as outdated (HTTP 426): it reads the deployment's device protocol
from the refusal and, when the deployment's is older, says to upgrade the deployment first.
