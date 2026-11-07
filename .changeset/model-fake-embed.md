---
"@capybara-hq/plugin-model-fake": minor
---

model-fake lists model kinds, serves a deterministic embedding model (`kind: "embedding"`, with
`dimensions` and `maxBatch`) through `embed`, and reads its model list from the per-call config
(the `models` field is overridable by an org).
