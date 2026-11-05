---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

A wait in a shared conversation names who has to act. `approval_requested` (and a sub-agent's
`subagent_waiting` for an approval) records the approval's `requestedFor` and `approverRole`
(display only, not model-visible; absent in older logs). The conversation page words a waiting
call by it: "等待你批准" for the viewer, "等待 张三 批准" / "Waiting for 张三 to approve" for a
member, the role for an approval escalated by role, and the run's starter for a question or a
connection. The approval card tells a viewer who cannot decide whom it waits for, and a decision
by someone else shows their name instead of their account id. The member list is read only when
the log names someone other than the viewer.
