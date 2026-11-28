---
"@capybara-hq/kernel": patch
---

Record the rerun point on `permission_reviewed` when a browser tool call reruns under an existing loopback port grant, so a crash before attempt 2 resumes the rerun instead of ending as `Result unknown`.
