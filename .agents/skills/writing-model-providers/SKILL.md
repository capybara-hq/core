---
name: writing-model-providers
description: 'Use when changing the kernel side of model-provider@2 or plugins/model-fake: the contract and its SDK types, parameter declarations and standard knobs (validateParams, sanitizeParams, assertValidDeclarations), @1 compatibility, append-only history and opaque replay as the runtime relies on them, media blocks (the vision / documents gate, MEDIA_LIMITS, placeholders, ref resolution, media_excluded), usage semantics, the ModelError kinds and the kernel degradation ladder, no retries inside the extension, streamIdleTimeoutMs, the conformance suite and startFakeModelServer in @capybara-hq/testing, and the model-fake script syntax. To write a provider extension (anthropic, openai, openai-compatible, dialects, live-API tests) see writing-model-providers in capybara-hq/plugins.'
---

# Model providers: the kernel side of `model-provider@2`

This skill covers what core owns: the contract as the kernel calls it, capability gating, media limits and placeholders, append-only history and opaque replay as the runtime relies on them, retries and fallback, the conformance suite and fake model server in `@capybara-hq/testing`, and `plugins/model-fake` (it stays in core and is published to npm as `@capybara-hq/plugin-model-fake` for the plugins repository's kernel-level tests). For the extension host see `.agents/skills/writing-extensions`.

**Writing a provider extension** (native SDKs, request / stream / error mapping, dialect presets, fixtures, live-API keys, model patches, the new-provider checklist) is in [writing-model-providers in capybara-hq/plugins](https://github.com/capybara-hq/plugins/tree/main/.agents/skills/writing-model-providers). The official providers are [`anthropic`](https://github.com/capybara-hq/plugins/tree/main/plugins/anthropic) (Messages API), [`openai`](https://github.com/capybara-hq/plugins/tree/main/plugins/openai) (Responses API) and [`openai-compatible`](https://github.com/capybara-hq/plugins/tree/main/plugins/openai-compatible) (Chat Completions + dialect presets; a bootstrap plugin every deployment installs). A change to the contract or to what the kernel sends them must keep them working: run their tests in capybara-hq/plugins against the changed SDK / testing packages.

## Contract: `model-provider@2`

The types are in `@capybara-hq/plugin-sdk` (`packages/plugin-sdk/src/model.ts`). The extension manifest has `provides: [MODEL_PROVIDER_EXTENSION_POINT_V2]` (that is, `model-provider@2`), and `setup` calls `ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, provider)`:

```ts
interface ModelProvider {
  listModels(): Promise<ModelInfo[]>;
  /** The event sequence must end with exactly one message_complete; on error, throw ModelError. */
  stream(req: ModelRequest, opts: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
}
```

- `ModelRequest`: `model`, `system` (`{ text, cache }[]`, stable content first, a cache breakpoint after blocks with `cache: true`), `messages` (user / assistant / mid-conversation `system`), `tools`, optional `toolChoice` (`"auto"` / `"none"`), `maxOutputTokens`, `params` (the parameters for this call, see the next section; the kernel has already processed them against the model's declarations: undeclared / invalid entries dropped, defaults filled in).
- `toolChoice: "none"`: in the wrap-up call at the step limit the kernel still sends `tools` as usual (some providers require tools to be declared when the history contains tool calls, and it also keeps the cache prefix stable), but the model must not call tools. The extension maps it to the native field (anthropic `tool_choice: {type: "none"}`, OpenAI Responses / Chat Completions `tool_choice: "none"`); `"auto"` / absent is not sent, and it is not sent when `tools` is empty either; a provider that cannot do this must guarantee it produces no `tool_call` (e.g. model-fake). For a model whose `capabilities.tools` is false, the kernel sends neither tools nor `toolChoice`, and writes a reminder telling the model there are no tools this time, so a model that can really call tools must declare `tools: true`.
- `ModelStreamEvent`: `text_delta`, `thinking_delta`, and finally exactly one `message_complete { content, stopReason, usage }`. The deltas concatenated must equal the text in the final `content`. A truncated stream (the provider's end event was not received) must throw (usually `network`); it **must not** send `message_complete` with half the content.
- `ContentBlock`: `text`, `thinking`, `tool_call`, `tool_result`, and `image` / `document`, which appear only in user messages (see "Media blocks"); `text`, `thinking` and `tool_call` may carry `opaque` (see below).
- `ModelInfo`: `contextWindow`, `maxOutputTokens`, `capabilities` (`tools` / `vision` / `reasoning` / `caching` / `midConversationSystem` / optional `documents`; `effort` is deprecated and used only by `@1`), optional `streamIdleTimeoutMs`, and required `parameters` (the parameter declarations the model supports; may be an empty array). The kernel caches `listModels`; on failure the kernel skips that provider and logs it, without affecting other providers.
- Always use `isModelError(e)` / `isRetryableKind(kind)` (duck typing) to check errors, never `instanceof ModelError`: an extension may ship with another copy of plugin-sdk.

An extension has no mutable in-process state: caches such as model info go in `ctx.kv` (with a TTL; bump the key's version when the ModelInfo shape changes), and accumulators within one call are request-local variables.

## Parameter declarations (`ModelInfo.parameters`)

A model declares the parameters it supports in `parameters`; the agent version's `modelParams` / `fallbackParams` are validated against the declarations (strict on save, lenient at runtime), the request carries `req.params`, and the extension maps them to the native request. **Adding a parameter changes only the extension, not the frontend**: the web agent form renders controls straight from the declarations, with the text coming from the `label` / `description` in the declaration.

```ts
interface ModelParameter {
  key: string;                       // a standard knob name, or "<plugin name>.<name>"
  standard?: "effort" | "thinking" | "temperature" | "maxOutputTokens"; // required for standard knobs and equal to key; vendor parameters must not set it
  schema: ParamSchema;               // a restricted JSON Schema subset
  default?: ParamValue;              // must satisfy schema
  label: { zh: string; en: string }; // both required, non-empty
  description?: { zh: string; en: string };
}
```

- **The schema may only be one of these**: `{ type: "string", enum: [...] }`, `{ type: "string", maxLength? }`, `{ type: "boolean" }`, `{ type: "number" | "integer", minimum?, maximum? }`. The kernel validates them itself and does not bring in ajv.
- **Key names**: standard knobs use `effort` / `thinking` / `temperature` / `maxOutputTokens` directly; vendor-specific parameters must be `<plugin name>.<name>`, with the prefix exactly equal to the extension name (`model-fake.style`, `openai-compatible.xxx`). If this is violated the provider is unavailable at load time (`assertValidDeclarations` throws).
- **Standard knob semantics** (uniform across the platform, portable when switching models / fallbacks, rendered specially in the UI):

| Knob | schema | Semantics |
|---|---|---|
| `effort` | `string` enum, a subset of `low|medium|high|xhigh|max` | Thinking depth; the levels are decided by the model |
| `thinking` | `string` enum, a subset of `off|on|summarized` | Thinking mode: `off` disables, `on` enables, `summarized` enables and returns a thinking summary |
| `temperature` | `number` (may have a range) | Sampling temperature |
| `maxOutputTokens` | `integer` (may have a range) | Maximum output tokens; the kernel uses it to override `runtime.maxOutputTokens` (capped at the model limit) |

- **Declare a default only when it matches the provider API's own default**, so that "unset" and "set to the default" behave the same; when the provider default varies by model or can't be looked up, give no default (neither openai's effort nor Qwen's thinking has one). Exception: anthropic's thinking defaults to `summarized` (the provider by default doesn't return thinking text; the platform chooses to return a summary).
- Not every model has every knob: anthropic has no `temperature`; openai declares `thinking` only when the deployment has `reasoningSummary != "off"`. Don't declare or send unsupported parameters.
- The pure functions are in plugin-sdk: `assertValidDeclarations(plugin, decls)` (used in extension self-tests and by the kernel at load time), `validateParams`, `sanitizeParams`. The conformance suite has a `declares valid parameters` case.
- Parameter decisions are recorded in the `model_call` event (`params`, and `droppedParams` when something was dropped), so the request can be reconstructed from the log.

## `@1` compatibility

The old contract `model-provider@1` (`ModelProviderV1` / `ModelInfoV1` / `ModelRequestV1`, `capabilities.effort` + `req.effort`) still works: through an adapter layer the kernel derives the `effort` knob from `capabilities.effort` (five levels, no default) and maps `params.effort` to `req.effort`. When one extension provides both, `@2` is used. New extensions always write `@2`; `capabilities.effort` is deprecated. The kernel's model list cache key carries the contract major version, the extension version and a digest of the deployment config, so after an extension upgrade or a deployment config change every replica validates against the new declarations immediately and never reads a stale list.

## Provider-side rules (in the plugins repository)

Dialect presets for Chat Completions-compatible services, the native-protocol principle (each provider calls its native API with its own official SDK, never through a compatibility layer, so provider-private capabilities such as thinking signatures, encrypted reasoning items and cache breakpoints survive), the per-provider mapping of each block and the fixtures are author guidance, kept in the plugins repository's skill. The sections below are the parts of the contract the kernel depends on.

## Request mapping is append-only

The kernel guarantees that "the history sent to the model is append-only": the message sequence of an earlier request is a prefix of a later request's (this is also what makes prompt cache hits possible). The extension's mapping must preserve this:

- **Each message's mapping depends only on itself and the request-level settings** (the requested model and its attributes, the request's `tools` and `params`), **and does not look at other messages**: no looking at later messages, no reordering based on later messages, no merging or splitting of messages already sent. Providers write it as a pure function and unit test that "the mapped result of request A is a prefix of the mapped result of request A plus some new messages (request-level settings unchanged)".
  - Cost: when request-level settings change between two requests (for example tools are included from this turn on, or thinking is switched), the serialization of earlier turns changes with them, the provider's prefix cache is invalidated before the change point, and input is billed once more; the history the kernel sees is still append-only, so correctness is unaffected. After M3 brought in tools, watch for this when the tools set changes in the middle of a conversation.
- Mid-conversation `system` messages: if the provider has a native representation that needs no surrounding context, use it (openai converts it in place to a `developer` input item, `midConversationSystem: true`); if the native representation has placement rules and needs to see later messages to decide where to put it, **don't use it**; convert it in place to a user text block `"[system] " + text` and report `midConversationSystem: false`. This is what anthropic does: the placement rules of its native system need lookahead (the position changes when skipped empty turns or failed steps follow), which would rewrite an already sent prefix.
- Provider-private blocks (thinking, reasoning items) are replayed as they are, without rewriting or reordering; ones that can't be replayed (see below) are dropped whole.
- Don't put the history cache breakpoint on "the last block of the last message": on the next turn the breakpoint moves to the new last block, and the bytes of the already sent message change with it. anthropic uses the automatic top-level `cache_control` on the request (the API itself places the breakpoint on the last cacheable block, which takes one breakpoint slot, and is not added when system has already used all 4); openai's cache is automatically prefix-based anyway.
- Parameters the model doesn't support are neither sent nor declared: anthropic declares and sends `thinking` only for models that the Models API reports as supporting adaptive thinking, and takes the `effort` levels from the Models API's per-level `supported`.

## Opaque replay: only replay to the same provider and the same model

`opaque = { provider, model, data }` is provider-private data (Anthropic thinking blocks and their signatures, OpenAI reasoning items containing `encrypted_content`, the output item ids of function_call and message). Rules:

- When producing it, `data` stores the native block as is (it can be put straight back into the next request), `provider` is the extension name, and `model` is **the model id that the next turn will accept it under**:
  - openai uses the **request's** model id (the `model` in the response is a dated snapshot name; labeling by it would never match on the next turn);
  - anthropic uses the response's `model`; when **server-side refusal fallback** (`fallbacks: "default"`) occurs, a `fallback` block appears in the message, and the thinking / tool opaque of the whole message is relabeled with `fallback.to.model` (the model that actually answered), otherwise replaying to the original model on the next turn would be rejected for failing signature validation (R39).
- On replay, put it back as is only when `opaque.provider === this extension && opaque.model === req.model && data != null`; otherwise: a thinking block is dropped whole, and a tool call degrades to a plain call without the private fields (openai drops the output item id). When an agent switches models or goes to a `fallback` model, the history contains blocks from other models; that is normal.
- openai's reasoning models require a replayed reasoning item to **immediately precede the output item it produced**: a text block's opaque stores the message output item's `id` (and `phase`), and when a reasoning item has already been replayed in the same assistant message, the text is replayed as the original message item (`{ type: "message", id, role: "assistant", status, content: [output_text] }`); when no reasoning item was replayed, no id is included (a msg_ id on its own is rejected). The mapping looks only at the message itself and is still append-only. (A provider-side rule; the kernel only carries the opaque data.)

## Media blocks (`image` / `document`)

User messages can contain `image` (png / jpeg / gif / webp) and `document` (`application/pdf`, `text/plain` / `text/markdown` / `text/csv`), with `source` as `{ kind: "base64", data }`, and an optional attachment name `name`.

- **The gate is in the kernel**: a model receives `image` only if it declares `vision: true`, and `document` only if it declares `documents: true` (when `documents` is true, `text/*` also arrives as document blocks); when unsupported, the kernel substitutes an English text placeholder or inline text, and the extension needn't check capabilities. So **declarations must be accurate**: declare per the official docs or the Models API, and note the source and verification date in a comment. anthropic takes the Models API's `image_input` / `pdf_input`; openai gets it from the deployment config `models[].vision` / `documents` (default false); openai-compatible follows the endpoint model config `vision` / `documents` (default false), and `documents` can be enabled only on dialects whose Chat Completions accepts PDF (`pdfInput`: generic, qwen); deepseek / ark config validation rejects it.
- **The provider's media limits are also enforced by the kernel**, so the extension needn't check again: at most 20 images per request (the newest are kept), PDFs over 100 pages, `text/*` over 50 000 characters (truncated and noted, the same for both sending methods), a single block over `MEDIA_LIMITS` (images 5 MiB, documents 32 MiB, after decoding), or the whole request's media over `attachments.requestMediaBytes`; the kernel replaces these with an English placeholder or truncates. If the provider still rejects a request with media using `invalid_request` / `context_overflow`, the kernel writes `media_excluded`, and later requests replace those attachments with placeholders; so the extension only needs to map such rejections faithfully to the matching `ModelError`, and must not drop blocks or retry itself.
- **`ref` must not reach the extension**: the event log stores only references, and the kernel resolves them into `base64` when building the request. An extension receiving a `ref` is a kernel bug; throw `ModelError("invalid_request", …)` (not retryable) and don't silently drop it.
- **How references are resolved** (kernel side, the extension needn't do it, but worth knowing when debugging): attachment bytes live in object storage, and a block in the log is only `{ kind: "ref", attachmentId }`. When building the request, the bytes are fetched by reference and checked against the etag recorded at finalize: an attachment that was deleted / expired, an object that's missing, or a size or etag mismatch is a **definite absence** and is replaced by an English placeholder; a transient storage error makes this step retry as a retryable error and does not degrade to a placeholder (Ruling M4, otherwise the same log could not reconstruct the same request). Each `model_call` event's `request.media` records what happened to every attachment (`{ attachmentId, outcome, etag? }`, where outcome is bytes / inline / placeholder_unsupported / omitted / unavailable / too_many_pages / excluded), so the request can be reconstructed from the log.
- **Mapping** looks only at the block itself (still append-only); each official provider's native mapping is listed in the plugins repository's skill.
- **No media blocks in assistant messages**: model output is only text / thinking / tool calls; media blocks in assistant messages are never sent on replay.
- The conformance suite has "user message with image" (run only when the model declares `vision`), "user message with PDF document" and "user message with text document" (run only when it declares `documents`). The samples are generated at runtime by `@capybara-hq/testing` (a 64×64 solid red PNG, a one-page PDF printing a single word); the fixture server recognizes the samples in their native shape and reads the answer from the content (`isPngBase64`, `pdfSampleWord`), so the case fails if the mapping is wrong.

## Usage semantics (`ModelUsage`)

The three kinds of input do not overlap, and the kernel corrects the context estimate and decides when to compact using their **sum**:

- `inputTokens`: **uncached** input (the part that neither hit the cache nor was written to it), not the input total;
- `cacheReadTokens`: input read from the cache; `cacheWriteTokens`: input written to the cache by this call;
- The input total = `inputTokens + cacheReadTokens + cacheWriteTokens`.
- When the provider's input count already includes the cached part, **subtract it first**: openai `inputTokens = input_tokens − cached_tokens − cache_write_tokens` (floor 0); anthropic's `input_tokens` already excludes cache reads and writes, so use it directly.

## Error mapping

Always throw `ModelError(kind, message, { retryAfterMs?, cause })`. Decide only by the SDK exception class, the HTTP status code and the structured error `type` / `code`, and **never match error message strings**. When `signal` has already aborted, classify as `aborted` whatever the SDK threw.

| kind | Retryable | Typical source |
|---|---|---|
| `rate_limited` | yes | 429; fill `retryAfterMs` when `retry-after-ms` (milliseconds) or `retry-after` (seconds / HTTP date) is present |
| `overloaded` | yes | anthropic 529 / `overloaded_error` |
| `server` | yes | 5xx; `api_error` / `server_error`; an unrecognized error event mid-stream |
| `timeout` | yes | SDK connection timeout, 408, `timeout_error` |
| `network` | yes | connection failure, stream cut off before the end event |
| `auth` | no | 401 / 403; `billing_error`; openai `insufficient_quota` (a 429, but retrying is useless) |
| `invalid_request` | no | other 4xx; **malformed tool arguments** (see below); a 400 for a too-long prompt (anthropic has no dedicated type) |
| `context_overflow` | no | 413 / anthropic `request_too_large`; openai `context_length_exceeded` |
| `aborted` | no | aborted by the caller |

Retryable errors are handled by the kernel's degradation ladder (primary model -> retry the primary model once, waiting `retryAfterMs`, default 1 second, skipping the same-model retry if it exceeds 10 seconds -> the agent's `fallback` model); non-retryable errors fail the run directly (error code `model.<kind>`). The cost of misclassifying: labeling a problem with the request itself as retryable wastes retries and switches to the fallback model; labeling a transient failure as non-retryable fails a run that could have succeeded.

**Malformed tool arguments -> `invalid_request`**: throw `invalid_request` when the tool input JSON fails to parse or isn't an object. It is not retryable, so the kernel does not resend the same request or switch to the fallback model for it.

## No retries inside the extension

SDK clients always use `maxRetries: 0`. Retrying, waiting, degrading and `step_reset` are all done uniformly in the kernel; retrying again inside the extension stacks waits, bypasses the 10-second cap, and makes the `model_call` events disagree with the actual number of requests. An extension also must not set its own request timeout to cover for idle streams; that is the kernel watchdog's job (see below).

## `streamIdleTimeoutMs`

When more than the threshold passes between two stream events, the kernel's watchdog aborts locally and treats it as `timeout` (retryable). The threshold is `ModelInfo.streamIdleTimeoutMs`, and when it isn't given the kernel config `runtime.streamIdleMs` (default 60000) is used.

- An ordinary chat model can leave it unset and use the kernel default;
- A model whose reasoning / thinking phase may go a long time without events must set it large: anthropic uses 300000 uniformly (5 minutes); openai gets it per model from the deployment config `models[].streamIdleTimeoutMs`;
- Too small treats normal long thinking as hung and retries repeatedly; too large means a real hang takes a long time to reach degradation.

## Tests: the conformance suite, the fake model server and model-fake

Both live in `@capybara-hq/testing` and every provider extension, official or not, runs them; a change to either is a change for every provider (check the official ones in capybara-hq/plugins).

- `describeModelProviderConformance(name, setup)`: streaming text, tool round trip, thinking replay, caching, usage, mid-conversation system, abort, `declares valid parameters`, and the media cases ("user message with image" only when the model declares `vision`, "user message with PDF document" and "user message with text document" only when it declares `documents`). `setup` returns `{ provider, model, expect, cachePrefixTokens?, teardown }`; providers run it in fixture mode against `startFakeModelServer` and, with keys set, against the real API.
- The media samples are generated at runtime (a 64×64 solid red PNG, a one-page PDF printing a single word); the fixture server recognizes them in their native shape and reads the answer from the content (`isPngBase64`, `pdfSampleWord`), so the case fails if a mapping is wrong.
- `startFakeModelServer(routes)`: `routes(req)` receives `{ path, body, headers }` and returns `{ status, json, headers? }` (a normal / error response), `{ status: 200, sse: [{ event?, data }], delayMs? }` (SSE) or `{ stall: true }` (sends only the response headers and no data, used to test abort and the watchdog). `server.requests` records all requests, so a test can assert on the native request body actually sent.
- **`plugins/model-fake`** (core's own provider) runs the conformance suite with no fake server (`plugins/model-fake/test/conformance.test.ts`; it declares three `effort` levels and `model-fake.style`). Its script syntax (`echo:`, `slow:<ms>:`, `stall`, `fail:<kind>`, `tool:<name>:<json>`, `long:<n>`, other text replies `You said: …`) is in `src/script.ts`; kernel tests drive agent runs with it, and the plugins repository's kernel-level tests use it from npm, so a script change needs a changeset on `@capybara-hq/plugin-model-fake`. Core tests load no other provider; kernel-specific shapes use fixtures under `packages/kernel/test/fixtures/plugins/` (`model-script`, `model-media`, `model-looper`, `model-eval`, `model-fake-b`).
- Run: `pnpm exec vitest run plugins/model-fake`.

## Model or gateway patches stay in the extension

Special handling for a particular model or gateway (a parameter that returns 400 on some models, a gateway that does not support a header) goes **only in the matching extension**, keeping the kernel and the SDK contract provider-neutral. Don't add provider-specific branches to the kernel; the rules for writing such a patch (with its removal condition) are in the plugins repository's skill.
