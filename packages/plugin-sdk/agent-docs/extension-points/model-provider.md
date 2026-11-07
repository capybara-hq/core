# Authoring: extension point model-provider

<!-- generated:extension-point -->
- Name: `model-provider` (a ref is `model-provider@<major>`)
- Calls a model vendor's API and streams the result back to the runtime.
- Providers: several
- Enabled per org: no
- Brokered by the platform: yes (extensions use it only through `ctx`)
<!-- /generated -->

Contract: ModelProvider (`model.ts`); refs `model-provider@1` and `@2`

Map the kernel's messages and tools to the vendor API and stream the result. Do not retry inside the extension; return a `ModelError` with the right kind and let the kernel degrade. History sent to the model is append-only. Declare parameters and media support.

See `extensions` for the rules every extension follows.
