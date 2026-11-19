---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
"@capybara-hq/kernel": patch
---

The sandbox never writes the PATH-shim directories a later shell runs programs from:
`~/.local/bin` and `~/.cargo/bin` join `SANDBOX_MANDATORY_WRITE_DENIES`, and the new
`SANDBOX_HOME_WRITE_DENIES` (`~/bin`, anchored at the owner's home, checked with
`isSandboxHomeWriteDenied`) is denied by the device workers and never proposed by the kernel.
`cargo install` and similar installs into those directories need a per-call escalation.
