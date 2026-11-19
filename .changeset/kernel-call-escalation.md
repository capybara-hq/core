---
"@capybara-hq/kernel": patch
---

`Bash` can ask to run one call outside the OS sandbox (`sandbox: "escalated"` with a
`justification`, foreground or background). Request approval asks the person, Approve for me asks
the review model (it asks the person when it cannot decide), Full access asks nobody; fixed denies
and mandatory asks stay first. An approval grants full execution for exactly that call, only
within the device's Full access ceiling; unattended runs cannot escalate. Restricted `Bash`
refusals now tell the model it may retry escalated where the device and org allow it.

Escalation hardening: every escalation ask keeps the escalation statement first (a review model's
or fallback reason follows it), quotes the agent's justification (cleaned of line breaks and bidi
controls; 500 code points), and a background start discloses that it keeps running outside the
sandbox for at most its deadline. IM approval cards of an escalation have their own title and
lines. A call that asked for escalation runs escalated or is refused at admission with an
actionable text, and `tool_result.review.sandbox` comes from the admitted scope only. The retry
hint appears only on sandbox signals, never on credential or auth failures, and also for a
background start the scope refused.
