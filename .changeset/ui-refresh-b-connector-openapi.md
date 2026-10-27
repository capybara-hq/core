---
"@capybara-hq/plugin-connector-openapi": patch
---

Each tool carries its operation's `summary` as the display-only `title` (one line, control and invisible characters removed, at most 80 characters), so the conversation page and approvals name OpenAPI tools as "<connector>: <summary>" instead of the raw tool key. The title is not part of the tool's fingerprint: existing connectors pick it up on their next refresh without a review.
