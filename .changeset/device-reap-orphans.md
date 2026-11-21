---
"@capybara-hq/device": patch
---

On macOS the device settles work an earlier run of the program left behind, so a crash or restart
no longer refuses every later operation with "Earlier work on this device is not settled". Each
unknown journal entry with a recorded launch is checked against the process table: a process that
is gone, or whose pid now belongs to a process that started after the launch, settles the entry; a
process proven to be the one launched (its own group leader, started by the launch time read at
the spawn) is stopped and killed with its whole tree first, descendants that left its group
included. Nothing that cannot be proven ours is signalled or settled. A native operation that fails
after its helper launched (a skill marker written onto a directory, for one) settles the same way.
