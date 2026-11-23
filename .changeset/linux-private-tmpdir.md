---
"@capybara-hq/device": patch
---

A restricted command on a Linux host gets its own private temporary directory, as on macOS: a fresh
`capybara-op-<deviceId>/op-<pid>-…` directory (0700, in a 0700 per-device parent in the device
process's temp dir) exported as TMPDIR, TMP and TEMP, granted read and write for that command only
and removed when the operation ends (a crashed device's leftovers are swept by its next operation).
TMPDIR is no longer the first write root, so temporary files stay out of the project. Other
connections' parents in that temp dir are denied to the command (the owner ceiling now lists them
on Linux too).
