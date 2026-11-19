---
"@capybara-hq/kernel": patch
---

Images sent to a model are scaled to at most 2048 px and re-encoded (JPEG, or WebP with
transparency) when over 1 MiB, and the copy is cached between steps, so a conversation holding
several large images no longer re-uploads tens of megabytes on every step.
