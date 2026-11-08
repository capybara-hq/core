---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

IM time zone and language per person: channel@1 `InboundSender` gains optional `timeZone` (IANA)
and `locale` (`zh` / `en` or a BCP 47 tag). The kernel records on an IM `user_message` the
platform's zone (when valid), else the account setting, else the org default, and the platform's
language (`zh` / `zh-*` Chinese, any other tag English), else the UI language of the person's most
recent web message in the org, else the org's `locale`. Any message without a language uses the
latest web language the same way, and run start falls back to the author's settings for a message
from an older log. The fake channel's sender profile takes `timeZone` and `locale`.
