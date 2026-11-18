---
"@capybara-hq/kernel": patch
---

`ctx.models.generateImage` generates images for extensions with the org's model of a declared `image_generation` purpose (policy hooks fire first; a denial is `model.hook_denied`), and `ctx.models.describe` reports an image purpose's `imageGeneration` facts. Each call writes a `model_usage` row (migration 0160 adds `kind`, `output_images`, `output_tokens`, `cache_read_tokens` and `cache_write_tokens`) whose `usage.report` delivery is owed in the same transaction and reported with purpose `image`, the answer's output and cache tokens and `usage.outputImages`; conversation `usage` events with purpose `image` pass `outputImages` through too.
