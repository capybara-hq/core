---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A kernel whose stdout reader is gone no longer spins and ignores signals. When the reader of
the console exits (the `tee` of `pnpm dev:kernel` stopped by Ctrl-C, a closed pipe), every log
write failed with EPIPE as an uncaught exception, the process guard logged it (another write,
another EPIPE), and the endless chain of errors held the CPU at 100% and starved the exit, the
stop budget and a second signal. The logger now stops writing to a console stream after its first
error, and the guard logs nothing more once it decided to exit. `pnpm dev:kernel`'s log file
writer ignores Ctrl-C, so the shutdown's records reach `/tmp/capybara-dev-kernel.log` too.
