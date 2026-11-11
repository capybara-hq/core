---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Admin overview health for super admins: every kernel process now reports its presence (roles,
version, start time) in Redis every 15 s, and the new `GET /admin/overview/health` (with the
read-only Platform operation `admin.health`) answers the live replicas by role, the kernel queue
counts with failures in the last 24 hours, and channel, device and sandbox counts
