---
"@capybara-hq/kernel": minor
---

Stopping a sub-agent (`POST …/conversations/:id/abort` on its conversation) stops it and every
sub-agent below it; the root conversation's stop still stops only its own run. Deleting a root
conversation stops its whole sub-agent tree, and the wait sweep stops what a crash left running in
a deleted tree. A conversation's background task list and stop routes include the tasks of every
sub-agent below it, grandchildren too.
