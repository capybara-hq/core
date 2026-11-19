---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

A sandboxed command no longer reaches another process's UNIX socket inside its write roots. The
Linux broker connects a pathname UNIX socket only when the operation bound it itself (its dev and
inode recorded at the brokered bind), so a user D-Bus, a rootless `docker.sock`, ssh-agent or tmux
in a granted directory, or `~/.docker/run/docker.sock` under a project bound at the home, stays
unreachable. As defence in depth the kernel's candidate builder and admission and the device's root
check refuse a write root that is a system runtime or socket directory (`/run`, `/var/run`,
`/private/var/run`, `/dev`, `/proc`, `/sys`, `/tmp` and `/private/tmp` themselves, known socket
directories such as `/tmp/tmux-<uid>`): new SDK `sandboxRuntimeDirectoryOf` and
`SANDBOX_RUNTIME_DIRECTORIES`. The permission conformance gains the `foreign-unix` check.
