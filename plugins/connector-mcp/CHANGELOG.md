# @capybara-hq/plugin-connector-mcp

## 0.2.0

### Minor Changes

- 21b1385: Keep the MCP tool `title` (or `annotations.title`) as the display title of the tool, cleaned the way the kernel cleans it (control, bidi and invisible characters removed except ZWNJ and ZWJ, whitespace collapsed, trimmed) and cut to 80 characters; the raw title is still the description fallback for a tool without a description.

### Patch Changes

- Updated dependencies [89b4521]
- Updated dependencies [c2c826b]
- Updated dependencies [9a5a340]
- Updated dependencies [7f9627d]
- Updated dependencies [85d8d40]
- Updated dependencies [e07bdd4]
- Updated dependencies [b50154b]
- Updated dependencies [21b1385]
  - @capybara-hq/plugin-sdk@0.2.0
