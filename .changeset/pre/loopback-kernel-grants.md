---
"@capybara-hq/kernel": minor
---

Loopback port grants for device services. Grant records (`device_loopback_grants`) last 24 hours,
with at most 32 live ports per service. Every ensure of a device service sends its live set. A
grant, a revoke, the expiry pass, a deleted root conversation, a deleted device and every
narrowing outside-sandbox ceiling refresh the running service, and a failed send is retried until
it reaches the device.
