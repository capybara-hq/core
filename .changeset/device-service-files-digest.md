---
"@capybara-hq/device": patch
---

Device services get `CAPYBARA_SERVICE_WORKSPACE` (the device's workspace root). `service.ensure`
takes an optional `filesDigest` and may leave out `spec.files`: a start then reuses the files the
state directory holds when they were written under the same digest, and otherwise answers
`files_needed` (also when neither files nor a digest are sent).
