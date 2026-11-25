---
"@capybara-hq/kernel": patch
---

A run stopped while a tool's images are being stored keeps the tool's own result: the remaining
images are named as not stored because the run was stopped. Without an object store, a block that
is not an image still says it is the wrong type.
