---
name: writing-model-providers
description: Use when creating or modifying a model provider plugin (provides model-provider@2, e.g. plugins/anthropic, plugins/openai, plugins/openai-compatible, plugins/model-fake). Covers the contract, parameter declarations and standard knobs, dialect presets, the native-protocol principle, append-only request mapping, opaque replay, media blocks (image / document mapping and the vision / documents declarations), usage semantics, the error mapping table, no retries inside the plugin, streamIdleTimeoutMs, and writing fixtures with startFakeModelServer plus the live-API mode.
---

# Writing model provider plugins

General plugin authoring (manifest, config, ctx, the multi-replica prohibitions, dual-replica tests) is in `.agents/skills/writing-plugins`; this skill covers only what is specific to `model-provider@2`. Reference implementations: `plugins/anthropic` (Messages API), `plugins/openai` (Responses API), `plugins/openai-compatible` (Chat Completions + dialect presets). `plugins/model-fake` is a deterministic scripted model, used for kernel tests and key-free demos.

## Contract: `model-provider@2`

The types are in `@capybara-hq/plugin-sdk` (`packages/plugin-sdk/src/model.ts`). The plugin manifest has `provides: [MODEL_PROVIDER_CAPABILITY_V2]` (that is, `model-provider@2`), and `setup` calls `ctx.provide(MODEL_PROVIDER_CAPABILITY_V2, provider)`:

```ts
interface ModelProvider {
  listModels(): Promise<ModelInfo[]>;
  /** The event sequence must end with exactly one message_complete; on error, throw ModelError. */
  stream(req: ModelRequest, opts: { signal: AbortSignal }): AsyncIterable<ModelStreamEvent>;
}
```

- `ModelRequest`: `model`, `system` (`{ text, cache }[]`, stable content first, a cache breakpoint after blocks with `cache: true`), `messages` (user / assistant / mid-conversation `system`), `tools`, optional `toolChoice` (`"auto"` / `"none"`), `maxOutputTokens`, `params` (the parameters for this call, see the next section; the kernel has already processed them against the model's declarations: undeclared / invalid entries dropped, defaults filled in).
- `toolChoice: "none"`: in the wrap-up call at the step limit the kernel still sends `tools` as usual (some providers require tools to be declared when the history contains tool calls, and it also keeps the cache prefix stable), but the model must not call tools. The plugin maps it to the native field (anthropic `tool_choice: {type: "none"}`, OpenAI Responses / Chat Completions `tool_choice: "none"`); `"auto"` / absent is not sent, and it is not sent when `tools` is empty either; a provider that cannot do this must guarantee it produces no `tool_call` (e.g. model-fake). For a model whose `capabilities.tools` is false, the kernel sends neither tools nor `toolChoice`, and writes a reminder telling the model there are no tools this time, so a model that can really call tools must declare `tools: true`.
- `ModelStreamEvent`: `text_delta`, `thinking_delta`, and finally exactly one `message_complete { content, stopReason, usage }`. The deltas concatenated must equal the text in the final `content`. A truncated stream (the provider's end event was not received) must throw (usually `network`); it **must not** send `message_complete` with half the content.
- `ContentBlock`: `text`, `thinking`, `tool_call`, `tool_result`, and `image` / `document`, which appear only in user messages (see "Media blocks"); `text`, `thinking` and `tool_call` may carry `opaque` (see below).
- `ModelInfo`: `contextWindow`, `maxOutputTokens`, `capabilities` (`tools` / `vision` / `reasoning` / `caching` / `midConversationSystem` / optional `documents`; `effort` is deprecated and used only by `@1`), optional `streamIdleTimeoutMs`, and required `parameters` (the parameter declarations the model supports; may be an empty array). The kernel caches `listModels`; on failure the kernel skips that provider and logs it, without affecting other providers.
- Always use `isModelError(e)` / `isRetryableKind(kind)` (duck typing) to check errors, never `instanceof ModelError`: a plugin may ship with another copy of plugin-sdk.

A plugin has no mutable in-process state: caches such as model info go in `ctx.kv` (with a TTL; see anthropic's `models:v3:<id>`, bump the version when the ModelInfo shape changes, 3600 seconds), and accumulators within one call are request-local variables.

## Parameter declarations (`ModelInfo.parameters`)

A model declares the parameters it supports in `parameters`; the agent version's `modelParams` / `fallbackParams` are validated against the declarations (strict on save, lenient at runtime), the request carries `req.params`, and the plugin maps them to the native request. **Adding a parameter changes only the plugin, not the frontend**: the web agent form renders controls straight from the declarations, with the text coming from the `label` / `description` in the declaration.

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
- **Key names**: standard knobs use `effort` / `thinking` / `temperature` / `maxOutputTokens` directly; vendor-specific parameters must be `<plugin name>.<name>`, with the prefix exactly equal to the plugin name (`model-fake.style`, `openai-compatible.xxx`). If this is violated the provider is unavailable at load time (`assertValidDeclarations` throws).
- **Standard knob semantics** (uniform across the platform, portable when switching models / fallbacks, rendered specially in the UI):

| Knob | schema | Semantics |
|---|---|---|
| `effort` | `string` enum, a subset of `low|medium|high|xhigh|max` | Thinking depth; the levels are decided by the model |
| `thinking` | `string` enum, a subset of `off|on|summarized` | Thinking mode: `off` disables, `on` enables, `summarized` enables and returns a thinking summary |
| `temperature` | `number` (may have a range) | Sampling temperature |
| `maxOutputTokens` | `integer` (may have a range) | Maximum output tokens; the kernel uses it to override `runtime.maxOutputTokens` (capped at the model limit) |

- **Declare a default only when it matches the provider API's own default**, so that "unset" and "set to the default" behave the same; when the provider default varies by model or can't be looked up, give no default (neither openai's effort nor Qwen's thinking has one). Exception: anthropic's thinking defaults to `summarized` (the provider by default doesn't return thinking text; the platform chooses to return a summary).
- Not every model has every knob: anthropic has no `temperature`; openai declares `thinking` only when the deployment has `reasoningSummary != "off"`. Don't declare or send unsupported parameters.
- The pure functions are in plugin-sdk: `assertValidDeclarations(plugin, decls)` (used in plugin self-tests and by the kernel at load time), `validateParams`, `sanitizeParams`. The conformance suite has a `declares valid parameters` case.
- Parameter decisions are recorded in the `model_call` event (`params`, and `droppedParams` when something was dropped), so the request can be reconstructed from the log.

## `@1` compatibility

The old contract `model-provider@1` (`ModelProviderV1` / `ModelInfoV1` / `ModelRequestV1`, `capabilities.effort` + `req.effort`) still works: through an adapter layer the kernel derives the `effort` knob from `capabilities.effort` (five levels, no default) and maps `params.effort` to `req.effort`. When one plugin provides both, `@2` is used. New plugins always write `@2`; `capabilities.effort` is deprecated. The kernel's model list cache key carries the contract major version, the plugin version and a digest of the deployment config, so after a plugin upgrade or a deployment config change every replica validates against the new declarations immediately and never reads a stale list.

## Dialect presets (OpenAI-compatible APIs)

`plugins/openai-compatible` uses the official `openai` SDK's `chat.completions` to talk to various Chat Completions-compatible services. The differences between these services (thinking fields, usage fields, replay rules) are collected in the dialects in `src/dialects.ts`: a dialect is pure data plus stateless mapping functions (`parameters(model)` declares parameters, `applyParams` writes extension fields into the request body, `readDelta` reads thinking deltas, `replayAssistant` decides how thinking is replayed, `usage` converts usage). Key points:

- Verify every field against the provider's official docs, and note the source and verification date in a comment; don't implement fields you can't find.
- A dialect looks only at the message itself and request-level settings (the model and its deployment attributes, whether tools are present, the parameters), not at other messages, to stay "append-only" (see the next section).
- To add a dialect: add a `Dialect` in `dialects.ts`, register it in `DIALECTS` and in the `dialect` enum in the config, and add fixtures and error mapping cases.
- The external model id is `<endpoint name>/<model id>`; keys go in the top-level `apiKeys` (endpoint name -> key). The kernel recognizes `secret()` only on object field paths, and a key placed inside an `endpoints[]` array element makes the plugin be rejected at load.

## Native protocol: use the official SDK, not a compatibility layer

- Each provider calls its **native API** with its **own official SDK** (Anthropic -> `@anthropic-ai/sdk` Messages API; OpenAI -> `openai` Responses API). Don't use LangChain's chat model wrappers, and don't translate other vendors' models through an "OpenAI-compatible" API (`openai-compatible` is only for services that offer nothing but Chat Completions, such as DeepSeek, Qwen, vLLM; Anthropic / OpenAI's own models still go through their native plugins): compatibility layers lose provider-private capabilities such as thinking block signatures, encrypted reasoning items and cache breakpoints, and also hide real error types.
- Model capabilities follow the native API: fetch from the Models API whatever it provides (anthropic), and take the rest from deployment config (openai's `models[]` carries `contextWindow` / `maxOutputTokens` / `reasoning` / `vision`).

## Request mapping is append-only

The kernel guarantees that "the history sent to the model is append-only": the message sequence of an earlier request is a prefix of a later request's (this is also what makes prompt cache hits possible). The plugin's mapping must preserve this:

- **Each message's mapping depends only on itself and the request-level settings** (the requested model and its attributes, the request's `tools` and `params`), **and does not look at other messages**: no looking at later messages, no reordering based on later messages, no merging or splitting of messages already sent. Write it as a pure function `buildRequest(req)`, and unit test that "the mapped result of request A is a prefix of the mapped result of request A plus some new messages (request-level settings unchanged)". Example: in a request with tools and thinking not disabled, the DeepSeek dialect fills an empty `reasoning_content` into history turns that have no thinking from this model; this depends on the request-level tools / thinking, not on other messages.
  - Cost: when request-level settings change between two requests (for example tools are included from this turn on, or thinking is switched), the serialization of earlier turns changes with them, the provider's prefix cache is invalidated before the change point, and input is billed once more; the history the kernel sees is still append-only, so correctness is unaffected. After M3 brought in tools, watch for this when the tools set changes in the middle of a conversation.
- Mid-conversation `system` messages: if the provider has a native representation that needs no surrounding context, use it (openai converts it in place to a `developer` input item, `midConversationSystem: true`); if the native representation has placement rules and needs to see later messages to decide where to put it, **don't use it**; convert it in place to a user text block `"[system] " + text` and report `midConversationSystem: false`. This is what anthropic does: the placement rules of its native system need lookahead (the position changes when skipped empty turns or failed steps follow), which would rewrite an already sent prefix.
- Provider-private blocks (thinking, reasoning items) are replayed as they are, without rewriting or reordering; ones that can't be replayed (see below) are dropped whole.
- Don't put the history cache breakpoint on "the last block of the last message": on the next turn the breakpoint moves to the new last block, and the bytes of the already sent message change with it. anthropic uses the automatic top-level `cache_control` on the request (the API itself places the breakpoint on the last cacheable block, which takes one breakpoint slot, and is not added when system has already used all 4); openai's cache is automatically prefix-based anyway.
- Parameters the model doesn't support are neither sent nor declared: anthropic declares and sends `thinking` only for models that the Models API reports as supporting adaptive thinking, and takes the `effort` levels from the Models API's per-level `supported`.

## Opaque replay: only replay to the same provider and the same model

`opaque = { provider, model, data }` is provider-private data (Anthropic thinking blocks and their signatures, OpenAI reasoning items containing `encrypted_content`, the output item ids of function_call and message). Rules:

- When producing it, `data` stores the native block as is (it can be put straight back into the next request), `provider` is the plugin name, and `model` is **the model id that the next turn will accept it under**:
  - openai uses the **request's** model id (the `model` in the response is a dated snapshot name; labeling by it would never match on the next turn);
  - anthropic uses the response's `model`; when **server-side refusal fallback** (`fallbacks: "default"`) occurs, a `fallback` block appears in the message, and the thinking / tool opaque of the whole message is relabeled with `fallback.to.model` (the model that actually answered), otherwise replaying to the original model on the next turn would be rejected for failing signature validation (R39).
- On replay, put it back as is only when `opaque.provider === this plugin && opaque.model === req.model && data != null`; otherwise: a thinking block is dropped whole, and a tool call degrades to a plain call without the private fields (openai drops the output item id). When an agent switches models or goes to a `fallback` model, the history contains blocks from other models; that is normal.
- openai's reasoning models require a replayed reasoning item to **immediately precede the output item it produced**: a text block's opaque stores the message output item's `id` (and `phase`), and when a reasoning item has already been replayed in the same assistant message, the text is replayed as the original message item (`{ type: "message", id, role: "assistant", status, content: [output_text] }`); when no reasoning item was replayed, no id is included (a msg_ id on its own is rejected). The mapping looks only at the message itself and is still append-only. Fixtures enforce this rule, but **it has not yet been verified against the real API**; see "Run the live API before releasing" below.

## Media blocks (`image` / `document`)

User messages can contain `image` (png / jpeg / gif / webp) and `document` (`application/pdf`, `text/plain` / `text/markdown` / `text/csv`), with `source` as `{ kind: "base64", data }`, and an optional attachment name `name`.

- **The gate is in the kernel**: a model receives `image` only if it declares `vision: true`, and `document` only if it declares `documents: true` (when `documents` is true, `text/*` also arrives as document blocks); when unsupported, the kernel substitutes an English text placeholder or inline text, and the plugin needn't check capabilities. So **declarations must be accurate**: declare per the official docs or the Models API, and note the source and verification date in a comment. anthropic takes the Models API's `image_input` / `pdf_input`; openai gets it from the deployment config `models[].vision` / `documents` (default false); openai-compatible follows the endpoint model config `vision` / `documents` (default false), and `documents` can be enabled only on dialects whose Chat Completions accepts PDF (`pdfInput`: generic, qwen); deepseek / ark config validation rejects it.
- **The provider's media limits are also enforced by the kernel**, so the plugin needn't check again: at most 20 images per request (the newest are kept), PDFs over 100 pages, `text/*` over 50 000 characters (truncated and noted, the same for both sending methods), a single block over `MEDIA_LIMITS` (images 5 MiB, documents 32 MiB, after decoding), or the whole request's media over `attachments.requestMediaBytes`; the kernel replaces these with an English placeholder or truncates. If the provider still rejects a request with media using `invalid_request` / `context_overflow`, the kernel writes `media_excluded`, and later requests replace those attachments with placeholders; so the plugin only needs to map such rejections faithfully to the matching `ModelError`, and must not drop blocks or retry itself.
- **`ref` must not reach the plugin**: the event log stores only references, and the kernel resolves them into `base64` when building the request. A plugin receiving a `ref` is a kernel bug; throw `ModelError("invalid_request", …)` (not retryable) and don't silently drop it.
- **How references are resolved** (kernel side, the plugin needn't do it, but worth knowing when debugging): attachment bytes live in object storage, and a block in the log is only `{ kind: "ref", attachmentId }`. When building the request, the bytes are fetched by reference and checked against the etag recorded at finalize: an attachment that was deleted / expired, an object that's missing, or a size or etag mismatch is a **definite absence** and is replaced by an English placeholder; a transient storage error makes this step retry as a retryable error and does not degrade to a placeholder (Ruling M4, otherwise the same log could not reconstruct the same request). Each `model_call` event's `request.media` records what happened to every attachment (`{ attachmentId, outcome, etag? }`, where outcome is bytes / inline / placeholder_unsupported / omitted / unavailable / too_many_pages / excluded), so the request can be reconstructed from the log.
- **Mapping** (looks only at the block itself, still append-only):

| Plugin | Image | PDF | `text/*` |
|---|---|---|---|
| anthropic | `{type:"image", source:{type:"base64", media_type, data}}` | `{type:"document", source:{type:"base64", media_type:"application/pdf", data}, title?}` | `{type:"document", source:{type:"text", media_type:"text/plain", data:<UTF-8 text>}, title?}` |
| openai (Responses) | `input_image`, `image_url: "data:<type>;base64,…"`, `detail: "auto"` | `input_file`, `file_data` as a data URL, `filename` (with a `.pdf` suffix added) | `input_text`: `[Attached file "<name>" (<type>)]` + newline + text |
| openai-compatible (Chat Completions) | `{type:"image_url", image_url:{url:<data URL>}}` | `{type:"file", file:{filename, file_data}}` (only `pdfInput` dialects) | a text part, written the same as openai |

  When the provider API accepts only PDF documents, `text/*` is decoded as UTF-8 text with a first line giving the file name and type (the same format as the kernel's inline text). When an openai-compatible user message has only text, the content is still a string joined with `"\n\n"` (byte-for-byte identical to before media was introduced, and also compatible with services that don't accept content arrays); the parts array is used only when it contains images / PDFs.
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

**Malformed tool arguments -> `invalid_request`**: throw `invalid_request` when the tool input JSON fails to parse or isn't an object. If the SDK's streaming helper class pre-parses tool input itself and wraps a parse failure in a generic exception with no structural information (anthropic's `MessageStream` does this), don't use it: use the raw event stream directly (`create({ stream: true })`), accumulate the final message yourself and `JSON.parse` it (both anthropic and openai `map-stream.ts` do this).

## No retries inside the plugin

SDK clients always use `maxRetries: 0`. Retrying, waiting, degrading and `step_reset` are all done uniformly in the kernel; retrying again inside the plugin stacks waits, bypasses the 10-second cap, and makes the `model_call` events disagree with the actual number of requests. A plugin also must not set its own request timeout to cover for idle streams; that is the kernel watchdog's job (see below).

## `streamIdleTimeoutMs`

When more than the threshold passes between two stream events, the kernel's watchdog aborts locally and treats it as `timeout` (retryable). The threshold is `ModelInfo.streamIdleTimeoutMs`, and when it isn't given the kernel config `runtime.streamIdleMs` (default 60000) is used.

- An ordinary chat model can leave it unset and use the kernel default;
- A model whose reasoning / thinking phase may go a long time without events must set it large: anthropic uses 300000 uniformly (5 minutes); openai gets it per model from the deployment config `models[].streamIdleTimeoutMs`;
- Too small treats normal long thinking as hung and retries repeatedly; too large means a real hang takes a long time to reach degradation.

## Tests: fixture mode and live-API mode

Every provider plugin runs `@capybara-hq/testing`'s conformance suite `describeModelProviderConformance(name, setup)` (streaming text, tool round trip, thinking replay, caching, usage, mid-conversation system, abort). Both modes are written in the same `test/conformance.test.ts`:

```ts
import { describeModelProviderConformance, startFakeModelServer } from "@capybara-hq/testing";
import { describe } from "vitest";
import { createMyProvider } from "../src/index.js";
import { myRoutes } from "./fixtures.js";

// Fixture mode: a local fake server replays the native protocol; CI runs this by default
describeModelProviderConformance("my (fixtures)", async () => {
  const server = await startFakeModelServer(myRoutes());
  return {
    provider: createMyProvider({ apiKey: "sk-fixture", baseUrl: server.url, /* … */ }),
    model: "my-model",
    expect: { thinking: true, caching: true },
    teardown: () => server.stop(),
  };
});

// Live-API mode: runs only when a key is set
const LIVE_KEY = process.env.CAPYBARA_TEST_MY_API_KEY;
describe.skipIf(!LIVE_KEY)("live", () => {
  describeModelProviderConformance("my (live)", async () => ({
    provider: createMyProvider({ apiKey: LIVE_KEY ?? "" }),
    model: "my-cheap-model",
    expect: { thinking: true, caching: true },
    cachePrefixTokens: 6000, // the stable prefix must exceed the model's minimum cacheable length
    teardown: async () => {},
  }));
});
```

- `startFakeModelServer(routes)`: `routes(req)` receives `{ path, body, headers }` and returns `{ status, json, headers? }` (a normal / error response), `{ status: 200, sse: [{ event?, data }], delayMs? }` (SSE) or `{ stall: true }` (sends only the response headers and no data, used to test abort and the watchdog). `server.requests` records all requests, so you can assert on the native request body actually sent. Fixtures are handwritten in the provider's native format in the plugin's `test/fixtures.ts` (see `sseMessage`, `errorJson` in `plugins/anthropic/test/fixtures.ts`); don't record keys from real responses.
- The plugin constructor must accept `baseUrl`; fixture mode uses it to point at the fake server.
- Beyond the conformance suite, write a case for each row of the error mapping table above (429 with `retry-after`, 529, 5xx, 401/403, 400, 413, a mid-stream error event, stream truncation, malformed tool arguments, network failure, abort, stalled-stream abort), and prefix unit tests for the request mapping.
- Live-API mode: for anthropic set `CAPYBARA_TEST_ANTHROPIC_API_KEY` (runs `claude-haiku-5-5`); for openai set `CAPYBARA_TEST_OPENAI_API_KEY` and `CAPYBARA_TEST_OPENAI_MODEL`; for openai-compatible set `CAPYBARA_TEST_OAICOMPAT_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIALECT` (`generic` / `deepseek` / `qwen` / `ark`; it runs only when all four are set; optional `_VISION=1` / `_DOCUMENTS=1` declare that the model accepts images / PDFs, to run the media cases). Verified against the real API so far: anthropic (`claude-haiku-5-5`), DeepSeek (`deepseek-flash`, dialect `deepseek`), openai (`gpt-5-nano`); media (images, PDF, `text/*` documents) was verified on anthropic `claude-haiku-5-5` and openai `gpt-5-nano`, and the ark dialect's image mapping has **not yet been verified against the real API**. When unset, the test prints one info line saying it was skipped. After changing the request mapping or upgrading an SDK, run against the real API locally.
- **Run the live API before releasing**: CI has no keys, and fixtures are only an approximation handwritten from the docs and known errors. Before every provider plugin release, get the conformance suite passing against the real API (especially thinking replay: openai reasoning items + message items with ids, anthropic signed thinking blocks, and cache hits with top-level `cache_control`), and state in the release notes which models it was run on.
- `plugins/model-fake` also runs this conformance suite (no fake server needed; it declares three `effort` levels and `model-fake.style`); its script syntax (`echo:`, `slow:<ms>:`, `stall`, `fail:<kind>`, `tool:<name>:<json>`, `long:<n>`, other text replies `You said: …`) is in its source `src/script.ts`.

## Model or gateway patches live only in the plugin, with a note on when they can be removed

Special handling for a particular model or gateway (a parameter that returns 400 on some models, a field that needs a special value, a gateway that doesn't support a header) goes **only in the matching plugin**, keeping the kernel and the SDK contract provider-neutral. Comment every patch in place, saying:

1. What problem it patches (which model / gateway, what symptom);
2. **When it can be removed** (after the provider fixes it, after a model is retired, after some SDK version).

Examples: anthropic sends only `tool_choice: {type: "none"}` and not `any` / `tool` (these return 400 on current models; remove once models support them); thinking blocks use `display: "summarized"` (current models default to `omitted` and don't return thinking text). A patch that says only "workaround" without a removal condition stays forever.

## New provider plugin checklist

1. Create the plugin package (`@capybara-hq/plugin-<name>`) per `.agents/skills/writing-plugins`, depending on the official SDK and `@capybara-hq/plugin-sdk`, with devDependency `@capybara-hq/testing`.
2. Deployment config: `apiKey` uses `secret(...)`, optional `baseUrl`, the model list; SDK client `maxRetries: 0`. Every model returned by `listModels` carries `parameters`, and tests run it through `assertValidDeclarations`.
3. `map-request.ts` (pure function, append-only), `map-stream.ts` (raw event stream accumulation, opaque, usage), `errors.ts` (mapped per the table above).
4. Fixture-mode conformance suite + error mapping cases + mapping prefix unit tests; live-API mode passing locally.
5. Add a row and a config example to the README's "model provider plugins" table; `pnpm changeset` (new plugin: minor).
