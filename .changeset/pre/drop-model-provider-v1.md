---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/testing": minor
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`model-provider@1` is removed before 0.1.0 (no plugin provides it): the SDK drops
`ModelProviderV1`, `ModelInfoV1`, `ModelRequestV1`, the `@1` constant
`MODEL_PROVIDER_EXTENSION_POINT`, the deprecated `ModelInfo.capabilities.effort` and
`ModelRequest.effort`; `EXTENSION_POINTS["model-provider"].majors` is `[2]`, so the kernel refuses
to load a plugin providing `@1`, and its `@1` adapter is gone. `MODEL_PROVIDER_EXTENSION_POINT_V2`
stays the constant to provide. The conformance suite in `@capybara-hq/testing` runs only `@2`
targets: `ConformanceTarget` no longer has `contract` (drop `contract: 2`; `plugin` is required).
The kernel's model list cache keys no longer carry the contract major.
