---
"@capybara-hq/device": patch
"@capybara-hq/plugin-sdk": patch
---

Linux restricted execution: a directory move into a guarded place (`.claude`, `.config`, …) can no
longer slip between another operation's write check and its effect.

- Every restricted operation of a device now shares one files lock: an `flock` on a private file
  outside every sandbox (the device's state directory on a host, the container's `/dev/shm` for a
  local-Docker device). Each brokered write holds it shared from its check to its effect; a guarded
  directory move holds it exclusively (still EBUSY after 5 s). The launcher takes the lock as an
  inherited descriptor (`filesLockFd`, optional for other consumers) and refuses one inside a
  granted root; the restricted command never holds it.
- After each descriptor-relative create or rename (mkdir, mknod, open with O_CREAT, symlink, link,
  rename, the staged move's final rename) the broker checks where the parent sits now; an entry
  that landed at a denied path is undone and refused, and an undo that fails ends the operation.
  Truncation (O_TRUNC, truncate) waits for that check.
