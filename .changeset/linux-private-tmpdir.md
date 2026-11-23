---
"@capybara-hq/device": patch
---

A restricted command on a Linux host gets its own private temporary directory, as on macOS: a fresh
`op-<pid>-…` directory (0700) in a 0700 parent in the device's own tmp root
(`<workDir>/tmp/capybara-op-<deviceId>/`), exported as TMPDIR, TMP and TEMP, granted read and write
for that command only and removed when the operation ends (a crashed device's leftovers are swept by
its next operation). TMPDIR is no longer the first write root, so temporary files stay out of the
project. The tmp root lies in the connection's working directory, which every other connection
already cannot read. The private temp parent's overlap check now also compares the canonical forms
of the denied paths (macOS too).
