---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
"@capybara-hq/design": patch
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/capybara": patch
---

Person fields: a Platform write that needs a secret takes its field name in `askPerson`, and the
person types the value on the approval card on the web; it is sealed, read once by the resumed call
and never reaches the conversation, the audit or a log. Agents can now read and set extension
deployment config, org config and the org's config copy through the Platform tool.
