---
"@capybara-hq/device": patch
---

`capybara-device`: restricted commands and file operations on macOS (Request approval, Approve
for me) can no longer read files outside what they were granted. Before, every parent directory
of a granted root, `/` included, was opened for reading with its whole subtree, so a restricted
command could read almost any file of the machine except the denied secret paths. Reads are now
limited to the granted roots, the system and developer tool directories (`/System`, `/usr`,
`/bin`, `/sbin`, `/private/etc`, Homebrew, Xcode and the Command Line Tools, `/Library/Apple`,
`/Library/Frameworks`, installed JDKs, the time zone data), the version managers' data and a few
exact paths (`/tmp`, `/var` and `/etc` links, the random and terminal devices, the Xcode
selection, license and tool cache); parent directories can still be passed through but not
listed. The restricted self-check now also proves that an ordinary file it never granted stays
unreadable, and reports restricted execution unavailable otherwise.

Restricted commands and background tasks on macOS also get a working temporary directory again:
each gets its own empty, private one (`TMPDIR`, `TMP`, `TEMP`), removed when it ends (a crashed
device's are removed at the next launch). The runtime used to point `TMPDIR` at a shared
`/tmp/claude` the device refuses, so `pnpm`, `cc`, Python's and Node's temp files failed. `mktemp`
without a template still writes to macOS's shared user temporary directory, which stays closed:
pass `"$TMPDIR/x.XXXXXX"`.
