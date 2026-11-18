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

The old public permission inputs are gone. The config key `devices.autoMode` and
`CAPYBARA_DEVICES__AUTO_MODE` now fail validation with a message that names `devices.fullAccess`
and `capybara config migrate-permissions`. The admin settings no longer read or write
`devicesAutoMode`, and the org settings no longer read or write `autoMode` (including
`deployment.autoMode`); use `devicesFullAccess` and `fullAccess`. The refusals are renamed
`org.full_access_not_allowed` and `deployment.full_access_not_allowed`. Stored old keys are still
converted by the permission configuration publication.
