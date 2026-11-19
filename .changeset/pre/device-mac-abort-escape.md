---
"@capybara-hq/device": patch
---

`capybara-device`: an aborted or timed-out restricted command on macOS always completes. A
descendant that left the command's process group (`fork` + `setpgid`) could hold its output pipe
open, so the call never ended and the operation worker, its proxy and its private temporary
directory stayed behind. Cancellation now stops and kills the command's descendants found by
parent pid (including those in another group or session; one already reparented to launchd is
not found), and once the owned group is gone the worker closes the pipes after a short grace.
