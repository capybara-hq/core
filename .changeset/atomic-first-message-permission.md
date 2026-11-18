---
"@capybara-hq/web": patch
---

A new conversation's first send carries the chosen permission profile: Request approval, Approve
for me (the default) or Full access after its confirmation for the displayed device and scope, sent
with the message through the atomic first-message request (never created and then changed). A lost
answer is retried with the same request bytes and id, so it never makes a second conversation; a
409 drops Full access consent and asks again, and a changed request is sent as a new one while the
original keeps its Retry original. With every local device offline, a restricted first send goes
without a device.
