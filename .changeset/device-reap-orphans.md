---
"@capybara-hq/device": patch
---

On macOS the device settles work an earlier run of the program left behind, so a crash or restart
no longer refuses every later operation with "Earlier work on this device is not settled". Each
unknown journal entry with a recorded launch is checked against the process table: a process that
is gone, or whose pid now belongs to another process, settles the entry; a process proven to be
the one launched (its own group leader, started when the launch was recorded) is killed with its
process group first. Nothing that cannot be proven ours is signalled. A native operation that fails
after its helper launched (a skill marker written onto a directory, for one) settles the same way.
