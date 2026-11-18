---
"@capybara-hq/kernel": patch
---

The same bytes are delivered to the user once per run since the person last spoke: a second
`Deliver` (or generated image) with identical content creates no artifact and its result names the
artifact already delivered. Delivering v1, v2, then v1 of one path still delivers v1 again, and
`artifact_created` now records the content's sha256.
