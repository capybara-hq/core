---
"@capybara-hq/web": patch
---

An extension view refreshed while an older read of it was still in flight (for example right after
sending a message) is read again once that read ends, so a panel no longer keeps the view from
before the change.
