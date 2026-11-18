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
lookalikes) and no repository forged inside git's own subtrees; hook-manager files (husky,
pre-commit, lefthook, overcommit, simple-git-hooks, `.githooks`) denied; nothing moved out of a
protected name; names compared after NFKC and full case folding, identical in TypeScript
(`sandboxFoldName`'s table) and Python.
git's `index.stash.<n>`, `packed-refs.new` and `MERGE_AUTOSTASH` are allowlisted internals. A
brokered FIFO open no longer pins a broker thread. The launcher also accepts `nativeFd`, a verified descriptor of the native helper (exec mode).
New digests: `linux-sandbox.py` b17b714a445912508d5082598af42960df550387c4a73b379561af19b0b45c87,
`native-files.py` 09a78c9bb7264ad6a1fe3b1aadd4c0f489192dc47c903c7fcc42fdf405590b42.
