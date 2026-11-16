---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/testing": minor
---

Add the restricted Linux launcher and syscall broker (`linux-sandbox.py`, Landlock plus a seccomp
notification broker) to `SANDBOX_RUNTIME_SOURCE` (version 2). Landlock rules, broker checks and the
native helper share the consumer's pinned root descriptors; roots are never reopened by pathname.
Its probe reports restricted unavailable on unvalidated architectures (only aarch64 is validated),
Landlock ABI below 6 or a missing seccomp listener. Shipping the bytes is not a provider claim.

Add `runSandboxPermissionConformance` to `@capybara-hq/testing`: an actual-provider permission
suite (positive controls, sibling/symlink/protected-path and network denials, Full controls, both
overlap orders, component/root swaps, mutable syscall pointers, cancellation and narrowed scopes).
