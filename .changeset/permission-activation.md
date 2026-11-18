---
"@capybara-hq/kernel": minor
"@capybara-hq/device": minor
"@capybara-hq/testing": patch
---

Permission profiles are active: the kernel and `capybara-device` speak device protocol 3 only,
every builtin enters a device through the managed operation route, and each run records its
permission context. A restricted profile also reads the instance's staged skills root
(read-only); the working root comes from the held instance's committed roots; an instance gone
after a dispatched operation keeps the outcome unknown and is rebuilt for the next call; a run
another member triggers in an owner's conversation runs without the owner's device. A
`GenerateImage` call with `file_path` takes the same permission review as `Write`: an outside
directory is asked about (or reviewed) and granted for that call only. The testing helpers run on
the activated kernel.

`capybara-device` drops its protocol 2 surface: the old connection and dispatch (`killTagged`,
`killAll` and unscoped operations are refused as unknown), the host and switching executors, the
daily `capybara-device mode` command (use `capybara-device ceiling set`), the Docker executor's
own commands and its startup marker reaper (the container now only hosts permission operations),
and the last-good fallback of a broken `policy.json` (it is refused until fixed).
