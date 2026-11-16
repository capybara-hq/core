---
"@capybara-hq/plugin-sdk": patch
---

The Linux restricted launcher now reports restricted support on x86_64 as well as aarch64. The
real-kernel conformance suite passed on an x86_64 GitHub runner (Linux 7.0, Landlock enabled,
Docker's builtin seccomp profile) with every mechanism test required to run.
