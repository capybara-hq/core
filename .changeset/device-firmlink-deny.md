---
"@capybara-hq/device": patch
---

A project root spelled through the macOS data volume firmlink (`/System/Volumes/Data/...`) into
another connection or a denied secret path is refused as `project_refused` when it is chosen, as
its plain spelling already was, instead of only failing inside the sandbox at run time.
