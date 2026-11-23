---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

An approval asked by a member's own tool policy no longer fails to record (`approval_requested`
now takes `policy: "member"`). The web's API types now match the kernel routes they call
(checked by `check:web-api-parity`): plugins with themes, an org's upload awaiting confirmation,
migration-warning permissions, network grant refusals and skipped questions are typed and labeled,
the account avatar upload no longer sends a field the route refuses, and an agent avatar of another
image type is refused before the upload.
