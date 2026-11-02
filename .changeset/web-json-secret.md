---
"@capybara-hq/web": patch
---

A deployment config secret whose value is an object (such as openai-compatible's `apiKeys`) is now
entered as JSON and sent parsed, instead of as a string the kernel rejects with "expected record".
