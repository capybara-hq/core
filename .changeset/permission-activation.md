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

Kernel: the old background launcher is gone. A background `Bash` task starts, is polled, stopped
and read only by its exact device reference; no session-id script runs any more. Tasks left from
the old launcher are handed to the legacy retirement and never signalled or read live. A refused
background start, and an old task's failed launch, are reported in actionable words instead of
the device's raw message.

`capybara-device` drops its protocol 2 surface: the old connection and dispatch (`killTagged`,
`killAll` and unscoped operations are refused as unknown), the host and switching executors, the
daily `capybara-device mode` command (use `capybara-device ceiling set`), the Docker executor's
own commands and its startup marker reaper (the container now only hosts permission operations),
and the last-good fallback of a broken `policy.json` (it is refused until fixed).
Under protocol 3 the local `commands.log` records each exec and background start again (tag,
account, conversation, restricted or full isolation, exit code, the grants' source; never the
command or its environment) and every policy change from the deployment or the CLI.
Upgrading from a protocol 2 `capybara-device`: processes the old auto mode left running are not
searched for; restart the machine or kill leftovers from before the upgrade. A Docker-mode
device's old container is recreated at its first operation (a container format version), and a
container found without its bridge is recreated, never reconnected.
