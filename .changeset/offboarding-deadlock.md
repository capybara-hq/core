---
"@capybara-hq/kernel": patch
---

Offboarding no longer deadlocks with a write to the member's conversation: the organization row
lock (`tryLockOrg` / `lockOrg`) and offboarding's locks on the member's agents and conversations
are `FOR NO KEY UPDATE`, so they still exclude each other and `FOR SHARE` readers but no longer
block foreign key checks. A directory sync used to report the removal as `failed` (40P01).
