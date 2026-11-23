---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/capybara": patch
---

`SANDBOX_RUNTIME_SOURCE.files` is now the Linux launcher with exact file read roots (the
`current` of core#742; `current` and `files` are the same again), and `accepted` keeps the earlier
launcher's digest for one revision so device containers made from an earlier device-docker image
stay available until they are recreated. The image pins device-docker rc.25 (its image stages the
new launcher and checks staged files against `accepted`) and device-local rc.7, at plugins commit
03a53c8.
