---
"@capybara-hq/device": minor
---

The device answers `list` (one directory's entries) and `scan` (directories holding `.git` or
`AGENTS.md`, at most two levels down) so the deployment can offer a device's projects, announces the
`projects` feature, and reports the owner's home in its hello. Each request is read in the mode it
would run in now (the owner's choice cut to the ceiling the request carries): auto mode reads with
the owner's rights, sandbox mode reads only the workspace through the sandboxed helper (killed with
its process group when the request is cancelled, even while it is still being spawned), and a
docker-mode device reads only its container's workspace. A scan reads at most 500 directories, skips
hidden directories and the SDK's `DEVICE_SCAN_SKIPPED_DIRS` / `DEVICE_SCAN_SKIPPED_BASE_DIRS`, and
follows no symbolic links. Both work while the device directory is gone (null / `[]`), and neither
recreates a removed workspace, so a lost workspace stays gone. The device keeps no project list of
its own.
