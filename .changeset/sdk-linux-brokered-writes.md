---
"@capybara-hq/plugin-sdk": patch
---

Restricted Linux exec now brokers every filesystem write and refuses the mandatory write denies:
`linux-sandbox.py` grants the command read access only to its write roots in Landlock, and each
write-capable open, create, mkdir, mknod, unlink, rename, link, symlink, truncate and metadata
change (and pathname UNIX binds) is performed by the broker on its own no-follow resolution from
the pinned descriptors; openat2 is refused. New exports `SANDBOX_MANDATORY_WRITE_DENIES`,
`SANDBOX_PROTECTED_PATH_NAMES` and `isSandboxWriteDenied` are the one list (git configuration and
hooks including `.git/commondir` and `.git/config.worktree`, shell startup files, editor and agent
configuration) that the launcher, `native-files.py` (roots with `denyWrites: true`) and consumers
share. The launcher also accepts `nativeFd`, a verified descriptor of the native helper (exec mode).
New digests: `linux-sandbox.py` fe40f468bce3f83ab0bd5a057b07af182f45525047845221bf4439e2f112b434,
`native-files.py` 6b906a675067e6282d35730334485017c287897ad0e57e77dc86755eef9eff2f.
