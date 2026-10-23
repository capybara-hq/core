---
"@capybara-hq/plugin-sdk": minor
---

Export `LocalizedText` (bilingual or plain text, used by `InputForm`; was the internal `Text`) and
`Locale` (`"zh" | "en"`, now also used by the channel and UI types), so the public API references
no unexported types.
