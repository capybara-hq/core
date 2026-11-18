---
"@capybara-hq/kernel": patch
---

A background `Bash` call whose launch was revoked or given up before its start was confirmed no
longer says the task was not started and that nothing runs: the process may have started, so the
call says so, that any process it started is being stopped, and to check its effects before
calling `Bash` again. `TaskList`, `TaskOutput` and the finished-task message show such a task's
reason (`launch_unknown`, `launch_revoked`) as text, not as a raw code.

The `permission_reviewed` record of an Approve for me review names who decided: `review-model`
only for the review model's own verdicts, `rule` for a fixed rule's deny, a rule ask and the
fail-closed ask.

A file call (`Read`, `Write`, `Edit`, `GenerateImage`) or a `cd` under a path a local device never
opens to restricted work (`~/.ssh`, `~/.aws` and the other secret paths, the device's state
directory) is refused at once with what to do instead, rather than asking the person to approve a
directory or a credential consent the device would always refuse.
