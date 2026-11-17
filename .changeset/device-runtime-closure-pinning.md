---
"@capybara-hq/device": patch
---

A restricted macOS worker no longer loads the sandbox runtime from the install by path. The
verification a binding relies on (`verifyInstalledRuntime` with `stageIn`) copies the exact bytes
it hashed into a private, content-addressed directory of the state directory and seals that copy;
workers import only from it. Each launch checks that the installed closure still holds the verified
bytes and that the copy is untouched: a changed byte, a replaced file, an added file or a link swap
(an in-place `npm update` while the service runs, say) refuses the launch with a typed unsupported
error until a restart or rebind verifies the runtime again.
