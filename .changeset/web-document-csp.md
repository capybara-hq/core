---
"@capybara-hq/web": patch
"@capybara-hq/capybara": patch
---

Every page document carries a content security policy with a fresh nonce per request:
`script-src <host>/_next/ <host>/api/v1/client/ 'nonce-<n>'; object-src 'none'; base-uri 'none';
frame-ancestors 'self'; form-action 'self'` (development adds `'unsafe-eval'`). Scripts never load
from the rest of the origin, which also serves user content. Next puts the nonce on its own
scripts; `/api`, `/plugin-ui`, `/_next`, the design catalog `/dev/ui`, `/icon.svg` and the
object-store proxy keep their own headers, and every other path (dotted ones too) gets the policy.
