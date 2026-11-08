---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Catalog and marketplace icon fixes. A display file inside a skill directory or at a template's
path (a plugin icon under `skills/<name>/`) is also stored in object storage, so the platform sync
of that skill no longer fails. Marketplace icons: a failed icon write is recovered by the next
refresh at the same commit; failed icon URLs are retried after 6 hours, after the URLs never
tried; stored icons are checked again (sha256 and content) when served.
