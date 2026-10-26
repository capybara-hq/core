---
"@capybara-hq/plugin-sdk": minor
---

`ToolSpec` gains display-only `title` and `keyArgs` (shown on the conversation page's tool rows, never sent to the model), checked by the new `validateToolPresentation` and by `validateToolSpec`. A title or key argument name with control, bidi or invisible characters (Unicode Cc / Cf) is rejected.

`ModelCallPurpose` gains `"title"`: conversation title calls fire `model.request` (a policy hook can deny them; the title is then skipped) and `model.response` with `purpose: "title"`, `runId: ""`, `step: 0`, `attempt: 1`. `UsageReportPayload.purpose` is a `UsagePurpose`, now the same values as `ModelCallPurpose`. A hook that switched exhaustively over `purpose` must handle `"title"`.
