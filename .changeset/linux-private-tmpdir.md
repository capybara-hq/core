---
"@capybara-hq/device": patch
---

A restricted command on a Linux host gets its own temporary directory, as on macOS: a fresh
`op-<pid>-…` directory (0700) in a 0700 parent beside the device's roots
(`<workDir>/capybara-op-<deviceId>/`), exported as TMPDIR, TMP and TEMP, granted read and write for
that command only and removed when the operation ends (a crashed device's leftovers are swept by its
next operation). TMPDIR is no longer the first write root, so temporary files stay out of the
project. The directory is private to the device (other connections cannot read the working
directory; under `machine` reach other operations of the same device can read it). A restricted
grant whose write root covers or lies inside that parent is refused, and the private temporary
directories are removed without following links (macOS too). The parent's overlap check also
compares the canonical forms of the denied paths.
