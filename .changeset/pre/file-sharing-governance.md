---
"@capybara-hq/kernel": minor
"@capybara-hq/web": patch
---

External sharing switches (platform `externalSharing`, default deny; org `externalSharing`, off until
an org admin turns it on), the share expiry maximum (`shareMaxExpiryDays`, default 30) and the HTML
rendering CDN allowlist (`htmlRenderCdnAllowlist`) as settings, with the `sharing.*` startup config
fields; the `file_shares` table. The web gains the error and audit labels for file shares.
