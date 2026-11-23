---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/capybara": patch
---

`SANDBOX_RUNTIME_SOURCE.files` is now the Linux launcher with exact file read roots (the
`current` of core#742; `current` and `files` are the same again), and `accepted` keeps the earlier
launcher's digest for one revision so device containers made from an earlier device-docker image
stay available until they are recreated. The bootstrap pins move to the device-docker release that
stages the new launcher.
