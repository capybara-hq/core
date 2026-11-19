---
"@capybara-hq/plugin-sdk": patch
---

`parseDeviceFrame` checks a `writeFile` payload's base64 in one linear pass: the previous pattern
overflowed the regex stack on Node 24 for payloads above about 3.3 MB, so larger device writes failed.
