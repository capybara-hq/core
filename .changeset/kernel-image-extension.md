---
"@capybara-hq/kernel": patch
---

`ctx.models.generateImage` generates images for extensions with the org's model of a declared `image_generation` purpose (policy hooks fire first; a denial is `model.hook_denied`), and `ctx.models.describe` reports an image purpose's `imageGeneration` facts. Each call writes a `model_usage` row (migration 0146 adds `kind` and `output_images`) whose `usage.report` delivery is owed in the same transaction and reported with purpose `image` and `usage.outputImages`; conversation `usage` events with purpose `image` pass `outputImages` through too.
