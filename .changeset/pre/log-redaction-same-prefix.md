---
"@capybara-hq/kernel": patch
---

Log redaction no longer slows down with many secrets that share a prefix: the matcher probes one set per distinct secret length instead of scanning every secret in the prefix bucket.
