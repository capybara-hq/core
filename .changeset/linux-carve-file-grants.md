---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

Linux machine reach reads the files beside a denied path. The SDK's restricted Linux launcher
accepts exact file read roots (`roots.readFiles`, exec mode only): each an O_PATH, no-follow
descriptor the consumer pinned, re-checked on that descriptor as a regular file with one name and
its recorded identity (a link, directory, FIFO, other type or hard-linked file is refused; one
renamed or deleted since the pin is skipped), and granted file reads only, without directory
listing or execution. The device's read carve now grants the non-denied regular files directly
inside each directory it expands (for example `~/.bashrc` when `~/.ssh` is denied,
`~/.cargo/config.toml` beside `~/.cargo/credentials`); the agent pins each without following links
and grants nothing for one that changed type or has a second name. Directories alone above 4096
refuse machine reach; files fill the rest of the cap and the agent's open-file budget, and the
rest are dropped. Comparisons with denied paths are case-insensitive for directories too, and
canonical forms of denied paths are read as bytes. The device deny list adds database, X11 and
other credential files (`~/.pgpass`, `~/.my.cnf`, `~/.Xauthority`, `~/.ICEauthority`,
`~/.config/hub`, `~/.boto`, `~/.dockercfg`, `~/.smbcredentials`) and REPL histories.
`linux-sandbox.py` changed: a provider staging it needs the new digest.
