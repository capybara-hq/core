# Model provider extensions

| Extension | Description |
|---|---|
| `@capybara-hq/plugin-openai-compatible` | **Bootstrap plugin** (baked into the image and installed by `init`; required, can't be disabled; no need to list it in `CAPYBARA_EXTENSIONS`). OpenAI-compatible Chat Completions services (DeepSeek, Qwen, vLLM and so on), configured per endpoint, with dialect presets for the differences |
| `@capybara-hq/plugin-model-fake` | Deterministic scripted model for tests and key-free demos |
| `@capybara-hq/plugin-anthropic` | Anthropic (official SDK + native Messages API), **optional bootstrap plugin** (preinstalled, off in each org until switched on) |
| `@capybara-hq/plugin-openai` | OpenAI (official SDK + native Responses API), **optional bootstrap plugin** (preinstalled, off in each org until switched on) |

You can use several at once: `openai-compatible` is a bootstrap plugin and the rest are installed as extension packages (see [Extensions](extensions.md)), during development too (`pnpm capybara extensions install npm:@capybara-hq/plugin-anthropic`; only `model-fake` can be listed in `CAPYBARA_EXTENSIONS`); deployment-level config goes in `CAPYBARA_EXTENSION_CONFIG` keyed by extension name, or is filled in by the super admin in the admin console. `anthropic` and `openai` are optional bootstrap plugins: preinstalled from npm by the bootstrap step, they only need their deployment config and an org admin switching them on.

Each model declares in its extension the parameters it supports (the standard knobs `effort`, `thinking`, `temperature`, `maxOutputTokens` and so on, plus vendor parameters of the form `<extension name>.<name>`); the web agent form renders from the declarations, and agent versions are validated against them on save.

A deployment-level config example for `openai-compatible` connecting to DeepSeek (the default example):

```bash
export CAPYBARA_EXTENSION_CONFIG='{"openai-compatible":{"endpoints":[{"name":"deepseek","baseUrl":"https://api.deepseek.com","dialect":"deepseek","models":[{"id":"deepseek-flash","contextWindow":1048576,"maxOutputTokens":393216,"reasoning":true}]}],"apiKeys":{"deepseek":"sk-..."}}}'
```

- `endpoints` (at least one): `name` (the endpoint name, without `/`), `baseUrl`, `dialect` (`generic` / `deepseek` / `qwen` / `ark`; the Ark baseUrl is `https://ark.cn-beijing.volces.com/api/v3`), and `models` (at least one: `id`, `contextWindow`, `maxOutputTokens`, and optionally `reasoning`, `vision`, `documents` (accepts PDF; only the generic and qwen dialects can enable it), `caching`, `streamIdleTimeoutMs`); optional `midConversationSystem` (overrides the dialect default). The public model id is `<endpoint name>/<model id>`, such as `deepseek/deepseek-flash`. The `contextWindow` / `maxOutputTokens` in the example above come from what DeepSeek `GET /models` returns for `deepseek-flash`; for other models, use their official responses.
- `apiKeys`: endpoint name → key. It is a **top-level** secret field (keys can't go inside `endpoints[]` array elements); each key must be a configured endpoint name, and endpoints without a key (such as an internal vLLM) are left out.
- Dialects: `deepseek` provides `thinking` (`on|off`, default `on`) and `effort` (`low|high|max`, default `high`); thinking content is read through `reasoning_content` and sent back following DeepSeek's rules. `qwen` provides `thinking` (mapped to `enable_thinking`). `ark` provides `thinking` (mapped to `thinking.type`, no default, thinking isn't sent back). `generic` provides only `temperature` and `maxOutputTokens`. Every dialect declares `temperature` and `maxOutputTokens`; thinking-related parameters are declared only for models configured with `reasoning: true`. When `reasoning` is omitted it is `false`: under the `deepseek` dialect, requests for such a model always send `thinking: { type: "disabled" }` (DeepSeek enables thinking by default), so DeepSeek reasoning models must set `"reasoning": true` explicitly.
- The current DeepSeek models are `deepseek-flash` and `deepseek-v4-pro`; `deepseek-reasoner` has been retired.
- The SDK doesn't retry; retries are handled uniformly by the kernel.

A deployment-level config example for `anthropic`:

```bash
pnpm capybara extensions install npm:@capybara-hq/plugin-anthropic --yes   # then approve and enable it
export CAPYBARA_EXTENSION_CONFIG='{"anthropic":{"apiKey":"sk-ant-...","models":["claude-opus-5-5","claude-sonnet-5-5","claude-haiku-5-5"],"serverFallbacks":"default"}}'
# or field by field: CAPYBARA_EXTENSION_CONFIG__ANTHROPIC__API_KEY=sk-ant-...
```

- `apiKey` (required, a secret field, masked in logs automatically); `baseUrl` (optional, a gateway or test fixture address).
- `models`: the allowed model ids, default `["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]`; model info comes from the Models API and is cached in kv for 1 hour.
- `serverFallbacks`: with `default` (the default), server-side refusal fallback is turned on for Claude Opus 5.5 / Opus 5 / Fable 5.1 / Sonnet 5.5 (beta `server-side-fallback-2026-07-01`, Claude API only); `off` turns it off.
- The SDK doesn't retry (`maxRetries: 0`); retries are handled uniformly by the kernel.

A deployment-level config example for `openai` (OpenAI's model endpoint doesn't return the context window and similar info, so the model list comes from config):

```bash
pnpm capybara extensions install npm:@capybara-hq/plugin-openai --yes   # then approve and enable it
export CAPYBARA_EXTENSION_CONFIG='{"openai":{"apiKey":"sk-...","models":[{"id":"gpt-5.5","contextWindow":400000,"maxOutputTokens":128000,"reasoning":true,"vision":true}]}}'
```

- `apiKey` (required, a secret field); `baseUrl`, `organization` (optional).
- `models` (at least one): `id`, `contextWindow`, `maxOutputTokens`, `reasoning`, `vision`, and optionally `documents` (whether PDF is accepted, default false), `streamIdleTimeoutMs` (the watchdog threshold for a reasoning model that produces no output for a long time), and `effortLevels` (the effort levels the model accepts, taken from `low|medium|high|xhigh|max` and declared in the given order; when omitted it is `low|medium|high`, which every reasoning model accepts; levels differ by model, for example gpt-5-nano doesn't accept `max`).
- `reasoningSummary`: `auto` (the default) requests reasoning summaries, and an agent can turn them off with the thinking parameter; accounts that haven't completed org verification have summary requests rejected, in which case set `off`, and the model also stops declaring the thinking parameter.
- Calls use `store: false`, and reasoning items are replayed verbatim as encrypted content; the SDK doesn't retry here either.

Live-API conformance tests are skipped by default and run only when the environment variables are set: anthropic uses `CAPYBARA_TEST_ANTHROPIC_API_KEY`; openai uses `CAPYBARA_TEST_OPENAI_API_KEY` and `CAPYBARA_TEST_OPENAI_MODEL`; openai-compatible uses `CAPYBARA_TEST_OAICOMPAT_BASE_URL` / `_API_KEY` / `_MODEL` / `_DIALECT` (it runs only when all four are set).

To write a model provider extension, see [.agents/skills/writing-model-providers](../../.agents/skills/writing-model-providers/SKILL.md).

`example-counter` ([capybara-hq/plugins](https://github.com/capybara-hq/plugins/tree/main/plugins/example-counter)) is the reference implementation for writing extensions; to write your own, see [.agents/skills/writing-extensions](../../.agents/skills/writing-extensions/SKILL.md), and for the list of config options see [docs/config.md](../config.md).
