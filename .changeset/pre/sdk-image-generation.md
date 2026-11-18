---
"@capybara-hq/plugin-sdk": patch
---

Image generation contract on `model-provider@2`: `ModelProvider.generateImage`, `ModelInfo.imageGeneration`, the `refusal` model error kind, `pickImageSize` / `validateImageGenerateResult` (which also checks the result's `usage`: whole non-negative token counts and `outputImages`), the `image` model call purpose with its request and response hook payloads, `ctx.models.generateImage`, and `kind: "image_generation"` in `permissions.models`.
