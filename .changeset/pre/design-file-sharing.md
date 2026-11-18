---
"@capybara-hq/design": patch
---

Add the pieces for file sharing: `HtmlDocumentFrame` (an HTML file as a sandboxed document,
`HTML_DOCUMENT_SANDBOX`), `CopyField` (a value to copy again, with the manual-copy fallback), a
Share action with a shared marker in the file preview header (`onShare`, `shared`), and the
`SharedFilePage` template (T14) for a shared file's public page.
