---
"@capybara-hq/kernel": patch
---

Stopping a conversation's run while it is just suspending onto an approval (a tool approval or a
secure input) now always ends the run: after asking a worker-held run to stop, the stop checks
whether the run became `waiting` meanwhile and ends the wait itself, as sub-agent stops already
did. Before, a stop that read the run as `running` just before it suspended could leave the run
waiting on its request.
