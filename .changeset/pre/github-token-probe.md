---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The `capybara:oauth-token-endpoint` setup check reads GitHub's token endpoint answers
(`bad_verification_code` accepted, `incorrect_client_credentials` refused), and its fix text no
longer names Slack's "Basic Information" page.
