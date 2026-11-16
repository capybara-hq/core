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

Messages may carry an `image` or a `document` block, gated by `capabilities.vision` and `capabilities.documents`; the kernel replaces a block the model cannot take with an English placeholder and never sends the bytes. A `file` block is an attachment the model can only reference (an xlsx, say): the kernel resolves it to text before the request, so a provider never receives one. Resolve any block you do not recognize by skipping it. The `size` on an attachment block is display metadata (the UI chip, the reference line) and is never sent to a provider.

See `extensions` for the rules every extension follows.
