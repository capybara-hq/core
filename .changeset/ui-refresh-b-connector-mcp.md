---
"@capybara-hq/plugin-connector-mcp": minor
---

Keep the MCP tool `title` (or `annotations.title`) as the display title of the tool, cleaned the way the kernel cleans it (control, bidi and invisible characters removed, whitespace collapsed, trimmed) and cut to 80 characters; the raw title is still the description fallback for a tool without a description.
