---
"@capybara-hq/testing": patch
---

`fake-im` registers setup checks for the kernel's check runner tests (`pass`, `fail`, `proxy`,
`throw`, `hang`, `ignore-signal`, `long`, `echo-secret`, `pad-to-limit`), and
`startFakeChannelServer` records the `proxy` check's `POST /checks` calls (`checks`) and can hold
their answers (`holdChecks`).
