---
"@capybara-hq/kernel": patch
---

Setup guides v2: the kernel validates `guides/<id>.md` (and `.zh.md`) at import with the SDK
validator, stores both documents as display files, and renders a guide per org, place, mode,
audience, locale and target (`GET …/catalog/:itemId/guides/:guideId` now returns blocks, checks,
unresolved variables with reasons and the v2 drift hash). Channel connection acks use the v2 hash;
a version imported with a v1 `setupGuides` entry shows no guide. The super admin previews a guide
with `GET /api/v1/admin/catalog/:itemId/guides/:guideId` (a Platform exclusion).
