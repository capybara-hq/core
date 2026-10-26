---
"@capybara-hq/plugin-sdk": minor
---

`ToolSpec` gains display-only `title` and `keyArgs` (shown on the conversation page's tool rows, never sent to the model), checked by the new `validateToolPresentation` and by `validateToolSpec`. A title or key argument name with control, bidi or invisible characters (Unicode Cc / Cf) is rejected.

`UsageReportPayload.purpose` is now a `UsagePurpose`: `ModelCallPurpose` or `"title"` (a conversation title call; it belongs to no run, so `runId` is `""`).
