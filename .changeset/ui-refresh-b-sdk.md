---
"@capybara-hq/plugin-sdk": minor
---

`ToolSpec` gains display-only `title` and `keyArgs` (shown on the conversation page's tool rows, never sent to the model), checked by the new `validateToolPresentation` and by `validateToolSpec`. A title or key argument name with control, bidi or invisible characters (Unicode Cc / Cf) is rejected.

`ModelCallPurpose` gains `"title"`: conversation title calls fire `model.request` (a policy hook can deny them; the title is then skipped) and `model.response` with `purpose: "title"`, `runId: ""`, `step: 0`, `attempt: 1`. `UsageReportPayload.purpose` is a `UsagePurpose`, now the same values as `ModelCallPurpose`. A hook that switched exhaustively over `purpose` must handle `"title"`.

New extension point `file-preview@1` (org scoped, several providers): a provider lists `previewers`, each with an id, a bilingual title, `accepts` (MIME types with `type/*` wildcards and / or file extensions), `maxBytes` (at most `FILE_PREVIEW_MAX_BYTES`, 20 MiB) and exactly one of `render(args) => UiView` or `embed` (the id of a ui contribution with the new place `"file-preview"`, embed only). `render` reads the file through `args.read()`, a grant for that one file valid only during the call; an embed previewer gets the file as the bridge message `{ type: "file", name, contentType, size, data }` after `init` and its token claims carry `fileId`. `validateFilePreviewProvider` and `previewerAccepts` are exported; an invalid provider fails `setup`.
