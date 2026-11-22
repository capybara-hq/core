---
"@capybara-hq/capybara": patch
---

The web's brand cookie is named `__Host-cb-brand` over https (plain `cb-brand` only over http), so a
sibling subdomain cannot plant the wordmark of error pages; the web keeps a trusted proxy's
`X-Forwarded-Proto` (`CAPYBARA_WEB_TRUST_PROXY`).
