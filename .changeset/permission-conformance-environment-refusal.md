---
"@capybara-hq/testing": patch
---

`SandboxPermissionFixture.restrictedEnvironment: "refused"` lets a provider whose policy refuses a
restricted filesystem with the environment network (a local device ties that network to Full
access) prove the refusal, a scope denial with nothing run, instead of the environment-network
UNIX probe. The permission conformance also proves the mandatory write denies: a restricted
command cannot write or create `.git/config` or git hooks (directly, by rename, hard or symbolic
link, or in a repository it creates), a `.git` pointer file, shell startup files or editor and
agent configuration, `.envrc` or `.npmrc` (also in case-folded and compatibility forms), the
configuration, hooks or pointers of submodule and worktree gitdirs, a bare-repository `HEAD`, or
move `.git` away, while ordinary git work in a restricted repository keeps working; native writes
of those paths are scope denials.
