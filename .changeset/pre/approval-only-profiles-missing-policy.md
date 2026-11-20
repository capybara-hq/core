---
"@capybara-hq/device": patch
---

A logged-in machine without `policy.json` (set up before rc.58, whose `login` wrote none) no longer
widens from no reachable host to the open network: `start` writes outside-the-sandbox off and the
allowlist network with no host, and prints how to open it (`capybara-device ceiling set --network
open`). Every reader (`ceiling show`, `policy show`, `status`, the running policy store) treats a
missing file as that closed ceiling; the strict reader and the owner report still refuse it. New
installs keep the open default.
