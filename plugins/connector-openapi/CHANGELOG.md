# @capybara-hq/plugin-connector-openapi

## 0.1.1

### Patch Changes

- 816ee36: Each tool carries its operation's `summary` as the display-only `title` (one line, control and invisible characters removed, at most 80 characters), so the conversation page and approvals name OpenAPI tools as "<connector>: <summary>" instead of the raw tool key. The title is not part of the tool's fingerprint: existing connectors pick it up on their next refresh without a review.
- Updated dependencies [89b4521]
- Updated dependencies [c2c826b]
- Updated dependencies [9a5a340]
- Updated dependencies [7f9627d]
- Updated dependencies [85d8d40]
- Updated dependencies [e07bdd4]
- Updated dependencies [b50154b]
- Updated dependencies [21b1385]
  - @capybara-hq/plugin-sdk@0.2.0
