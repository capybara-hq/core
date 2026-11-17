---
"@capybara-hq/plugin-sdk": patch
---

Restricted Linux exec now brokers every filesystem write and refuses the mandatory write denies:
`linux-sandbox.py` grants the command read access only to its write roots in Landlock, and each
write-capable open, create, mkdir, mknod, unlink, rename, link, symlink, truncate and metadata
change (and pathname UNIX binds) is performed by the broker on its own no-follow resolution from
the pinned descriptors; openat2 is refused. New exports (`isSandboxWriteDenied`, `isSandboxMoveDenied`,
`SANDBOX_MANDATORY_WRITE_DENIES`, `SANDBOX_GIT_ALLOWED_DIRECTORIES`, `SANDBOX_GIT_ALLOWED_FILES`,
`SANDBOX_GIT_DENIED_INTERNALS`, `SANDBOX_PROTECTED_PATH_NAMES`) are the one write policy the
launcher, `native-files.py` (roots with `denyWrites: true`) and consumers share: shell startup,
git-global, `.envrc`, `.npmrc`, editor and agent files; inside any `.git` (submodule and worktree
gitdirs included) only git's ordinary internals; no `HEAD` file outside `.git` (bare-repository
lookalikes); nothing moved out of a protected name; names compared after NFKC and case folding.
A brokered FIFO open no longer pins a broker thread. The launcher also accepts `nativeFd`, a verified descriptor of the native helper (exec mode).
New digests: `linux-sandbox.py` 49a078c36ea3c2ad31bfdb2381d872f87ed352e4d11a53a19e4dcfb13c0fe3cb,
`native-files.py` 5fa8d4d1a99a5492136f8fe944df9ca0887f30c0f6b1c861b51cd57cf8f2fd77.
