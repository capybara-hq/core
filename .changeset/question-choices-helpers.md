---
"@capybara-hq/plugin-sdk": patch
---

Add `questionChoiceButtons` and `questionBody` for channel plugins to render a question form's
`choices` as buttons and its `body` as text. `questionRenderableInline` is true for a form with
`choices`, and `renderCardAsText` writes the body and the pending choices (core#867, plugins#241).
