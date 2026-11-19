---
"@capybara-hq/device": patch
---

macOS: a command's process group that holds only dead members (zombies not yet reaped) no longer
fails the call or the stop. Darwin answers the group signal with EPERM there instead of ESRCH; the
worker now checks for a live member before treating EPERM as a failure, so an aborted or finished
command completes and a stop reports `stopped` instead of `cancel-pending`.
