---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

Linux machine reach reads the files beside a denied path. The SDK's restricted Linux launcher
accepts exact file read roots (`roots.readFiles`, exec mode only): each an O_PATH, no-follow
descriptor the consumer pinned, re-checked on that descriptor as a regular file with its recorded
identity (a link, directory, FIFO or other type is refused; one renamed, deleted or given a second
name since the pin is skipped), and granted file reads only, without directory
listing or execution. The device's read carve now grants the non-denied regular files directly
inside each directory it expands (for example `~/.bashrc` when `~/.ssh` is denied,
`~/.cargo/config.toml` beside `~/.cargo/credentials`); the agent pins each without following links
and grants nothing for one that changed type or has a second name. Directories alone above 4096
refuse machine reach; files fill the rest of the cap and the agent's open-file budget, and the
rest are dropped. Comparisons with denied paths are case-insensitive for directories too, and
canonical forms of denied paths are read as bytes. The device deny list adds database, X11 and
other credential files (`~/.pgpass`, `~/.my.cnf`, `~/.Xauthority`, `~/.ICEauthority`,
`~/.config/hub`, `~/.boto`, `~/.dockercfg`, `~/.smbcredentials`, `~/.terraformrc`,
`~/.yarnrc.yml`, `~/.databrickscfg`, `~/.passwd-s3fs`, `~/.erlang.cookie`, `~/.curlrc`,
`~/.wgetrc`, `~/.claude.json`) and more shell, REPL and editor histories.
`SANDBOX_RUNTIME_SOURCE` now has three parts so a runtime change no longer has to land in step
with the images that stage it: `files` (the staged set, unchanged: still the `linux-sandbox.py`
released images stage, so device-docker keeps working), `current` (the newest bytes, which
`capybara-device` runs; this launcher declares `features: ["fileReadRoots"]`) and `accepted` (by
name, every digest a staged copy may have). The device sends file roots only to a launcher that
declares them; otherwise the files stay unreadable as before. New types `SandboxRuntimeFile` and
`SandboxRuntimeFeature`.
