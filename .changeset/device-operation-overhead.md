---
"@capybara-hq/device": patch
---

Each restricted operation checks the staged sandbox runtime copy with concurrent `lstat` calls
instead of one after another (about 75–240 ms down to about 15 ms per operation on macOS). The
operation journal drops settled entries an hour past their retention instead of keeping one entry
per operation forever, which every commit rewrote and which would stop admission at 10,000.
