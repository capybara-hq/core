---
"@capybara-hq/kernel": patch
---

`Bash` can ask to run one call outside the OS sandbox (`sandbox: "escalated"` with a
`justification`, foreground or background). Request approval asks the person, Approve for me asks
the review model (it asks the person when it cannot decide), Full access asks nobody; fixed denies
and mandatory asks stay first. An approval grants full execution for exactly that call, only
within the device's Full access ceiling; unattended runs cannot escalate. Restricted `Bash`
refusals now tell the model it may retry escalated where the device and org allow it.
