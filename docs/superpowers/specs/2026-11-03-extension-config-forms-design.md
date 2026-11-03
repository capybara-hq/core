# Extension config forms

Status: draft (acceptance round 3, user direction 2026-11-02)

Related: `.agents/skills/writing-extensions` ("Two-level config"), `docs/design/spec.md` (§5.3 Form,
§6.2–6.3 controls), `docs/superpowers/specs/2026-11-01-web-ssr-design.md` (server-decided first
paint, which every page below keeps).

## 0. Why

During acceptance (2026-11-02) an enterprise admin opened Admin → Extensions → openai-compatible →
Config and saw:

- raw field paths as labels (`endpoints`, `apiKeys`);
- one blank JSON textarea for `endpoints`, an array of endpoint objects that each hold a `models`
  array;
- the secret `apiKeys` record (endpoint name → key) typed as JSON (the stopgap of 4151dfe5), far
  away from the endpoint it belongs to;
- the extension's id `openai-compatible` where a person expects "OpenAI 兼容".

The user's direction: the extension gets a localized display name everywhere; its form is not a
generic schema dump but a form shaped like the thing being configured: add endpoints, add models per
endpoint, `baseUrl` and the other fields as ordinary form items, the API key inside its endpoint.
Approved mechanism: **the config schema carries declarative UI hints, and one generic renderer in the
web app draws them. Extensions ship no config UI code** (an extension is not loaded until its config
is valid, so it cannot draw its own config form).

## 1. Principles

1. **The zod schema stays the single source of truth** for shape and validation. Hints only describe
   presentation; they never change what validates.
2. **Hints are data, serialized into the JSON Schema** the kernel already sends (`x-ui`), so the
   renderer needs nothing but the view it gets today.
3. **Secrets keep living at fixed object paths.** The kernel encrypts and masks a secret only at an
   object path (`assertSecretsReachable`); a hint may *draw* a secret elsewhere, never *store* it
   elsewhere.
4. **No regression without hints.** A schema without `x-ui` renders at least as well as today
   (nested objects and arrays become structured inputs instead of JSON, and the JSON textarea stays
   only for what cannot be structured).
5. **Validated once, at pack time, with the same code the kernel uses at load time.**

## 2. Display names

### 2.1 Today

`plugin.json` already accepts `displayName: { zh, en }` (`plugin.v1.schema.json`,
`LocalizedName`, ≤ 100 characters each). The catalog carries it (`catalog_items.display_name`), but
the extension side does not: `extension_packages` stores only the extension section,
`AdminExtensionView` has no display name, the models API returns `provider` only, and the web builds
labels like `${p.provider} / ${m.displayName}` (`PurposeEditor`, `AgentForm`, `AgentList`,
`lib/models.ts`, `agents/[id]`). No official plugin sets `displayName`.

### 2.2 Changes

- **Migration** `00NN_extension_display_name.sql`: `ALTER TABLE extension_packages ADD COLUMN IF NOT
  EXISTS display_name jsonb`. `ExtensionInstalls.ingest` writes the package's `plugin.json`
  `displayName` (null when absent). Config-declared extensions read it from their directory's
  `.capybara-plugin/plugin.json` when present.
- **One resolver** `extensionDisplayName(name)` in `packages/kernel/src/extensions`: the installed
  package's `display_name`, else the live catalog item of the same name, else null. No backfill:
  existing rows get a name when the bootstrap pins move (§8) or the extension is upgraded.
- **APIs** add `displayName: LocalizedName | null` to: `AdminExtensionView` (list and detail), the
  org extension list (`GET /api/v1/orgs/:orgId/extensions`), the models list
  (`providers[].displayName`), the channel plugin options, and the deployment config view.
- **Web**: one helper `extensionLabel({ name, displayName }, locale)` in `apps/web/src/lib`, used for
  list rows, the detail title, the breadcrumb's last segment, callouts (setup checklist, pending
  config), and every picker: the agent model select reads "OpenAI 兼容 / deepseek/deepseek-flash".
  The id stays visible as muted meta (list secondary text, detail header meta) because admins and
  the CLI still use it. Option values keep `provider/model`; only labels change.
- **Official plugins** all add `displayName` (§7); core's `model-fake` too ("模拟模型" / "Fake
  model").

## 3. SDK API (`@capybara-hq/plugin-sdk`)

### 3.1 Types and helpers (new file `src/config-ui.ts`)

```ts
/** Localized text: both languages required (UI text goes through i18n, zh and en). */
export interface LocalizedText { zh: string; en: string }

export type ConfigWidget =
  | "text" | "textarea" | "url" | "number" | "select" | "radio"
  | "switch" | "checkbox" | "tristate" | "tags" | "json";

export interface ConfigUiOption {
  value: string | number | boolean;
  label: LocalizedText;
  help?: LocalizedText;
}

export interface ConfigUiSection { id: string; label: LocalizedText; help?: LocalizedText }

export interface ConfigUiPreset {
  id: string;
  label: LocalizedText;
  help?: LocalizedText;
  /** Prefilled item fields; never a secret. */
  values: Record<string, unknown>;
}

/** A secret drawn inside each item of an array, stored at a fixed record path keyed by an item field. */
export interface ConfigUiItemSecret {
  /** Dot path, from the schema root, of a `secret(z.record(z.string(), z.string()))` field. */
  path: string;
  /** The item's string field whose value is the record key (e.g. `name`). */
  keyBy: string;
  label: LocalizedText;
  help?: LocalizedText;
  placeholder?: string | LocalizedText;
  /** The item field the input is drawn after (default: last). */
  after?: string;
}

export interface ConfigUiHints {
  label?: LocalizedText;
  help?: LocalizedText;
  placeholder?: string | LocalizedText;
  /** Shown after a number input ("tokens", "ms"). */
  unit?: LocalizedText;
  /** Sort key among siblings (default: declaration order). */
  order?: number;
  /** Root-level section id (`sections` on the root). */
  section?: string;
  /** Collapsed under "Advanced" in its object or item. */
  advanced?: boolean;
  widget?: ConfigWidget;
  options?: ConfigUiOption[];
  /** Objects (and array items): fields stacked (default) or one compact row. */
  layout?: "stack" | "row";
  /** Arrays: how each item is drawn and added. */
  item?: {
    /** `{field}` template from the item's own string / number fields, e.g. "{name}". */
    title?: string;
    subtitle?: string;
    addLabel?: LocalizedText;
    reorder?: boolean;
  };
  presets?: ConfigUiPreset[];
  secrets?: ConfigUiItemSecret[];
  /** Root only. */
  sections?: ConfigUiSection[];
  /** Root only: localized messages for custom issues (`params: { ui: key }`, §4.4). */
  messages?: Record<string, LocalizedText>;
}

/** Attaches hints, merging with existing meta (`secret`, `hot`). Returns the same schema type. */
export function ui<T extends z.ZodTypeAny>(schema: T, hints: ConfigUiHints): T;

/** Config schema → JSON Schema for forms (moved here from the kernel, §4.1). */
export function configJsonSchema(schema: z.ZodTypeAny): JsonSchema;

export interface ConfigUiProblem { path: string; message: string }
/** Validates the `x-ui` hints of a JSON Schema produced by `configJsonSchema` (§3.3). */
export function validateConfigUi(
  schema: JsonSchema,
  level: "deployment" | "org" | "connection",
): ConfigUiProblem[];
```

`secret()` changes to merge existing meta as well (today `secret(ui(x, …))` would drop the hints,
because zod's `.meta()` replaces). Both helpers: `schema.meta({ ...(schema.meta() ?? {}), … })`.
Convention: put `ui()` outermost, after `.default()` / `.optional()`.

### 3.2 Serialization

`configJsonSchema` is today's `configToJsonSchema` plus:

| zod meta | JSON Schema |
|---|---|
| `secret: true` | `"x-secret": true` (unchanged) |
| `hot: true` | `"x-hot": true` (today it leaks as `hot`) |
| `ui: {…}` | `"x-ui": {…}` (JSON as given) |
| `ui.label.en` / `ui.help.en` | also `title` / `description` when the schema has none, for other JSON Schema readers |

The secret scrub still runs after conversion (§4.2).

### 3.3 Validation rules (`validateConfigUi`)

One pure function over the JSON Schema, used by the packer, `capybara-plugin check` and the kernel:

- texts: `label` ≤ 100, `help` ≤ 500, `placeholder` ≤ 200 characters per language, both languages
  non-empty; total `x-ui` JSON per schema ≤ 64 KiB; ≤ 200 options, ≤ 20 presets, ≤ 20 sections;
- `options[].value` is a member of the node's `enum` / `const` values, each at most once;
- `widget` fits the type (`switch` / `checkbox` / `tristate` on booleans, `select` / `radio` on
  enums, `tags` on arrays of strings, `url` / `textarea` on strings, `number` on numbers);
- `item` / `presets` / `secrets` only on arrays; `presets` and `secrets` only on arrays of objects;
  `layout: "row"` only on objects whose properties are scalars (or arrays of objects whose items
  are);
- `item.title` / `subtitle` templates name scalar properties of the item;
- each preset's keys are item properties, their values match the property's JSON type and enum, and
  none is a secret;
- `secrets[]`: `path` resolves through `properties` from the root to an `x-secret` object with
  `additionalProperties: { type: "string" }`; `keyBy` is a string property of the item; `after` a
  property of the item; only at `level: "deployment"` (§4.3);
- `section` names a root `sections[].id`; `sections` and `messages` only on the root;
- hints on a secret node allow only `label`, `help`, `placeholder`, `order`, `section`, `advanced`.

## 4. Kernel

### 4.1 Pass-through

`config-json-schema.ts` re-exports the SDK's `configJsonSchema` (the kernel keeps no copy). The three
callers stay as they are: `deployment-config.ts` `jsonSchemaOf`, `org-config.ts` `orgJsonSchema`,
`channels/connections.service.ts`. At load (`importInstalled` and config-declared loading) the host
runs `validateConfigUi` on the deployment and org schemas; problems do **not** fail the load: the
kernel strips `x-ui` from that schema, logs one warning per extension version and adds a status
detail. The packer already refuses such a package (§5.3), so this only covers hand-made packages.

### 4.2 Scrub

`scrubSecrets` keeps removing `default` / `examples` / `const` / `enum` under secret nodes and also
removes `x-ui.options` and `x-ui.presets` there. Presets never reach a secret (rule §3.3), so no
secret value can be published through hints.

### 4.3 Record secrets drawn per item

`apiKeys` is a single secret field (path `apiKeys`, a record). The web cannot read its values, so it
cannot rebuild the record when one endpoint's key changes. The deployment config API gains entry
operations, only for paths some `x-ui.secrets[].path` names:

- **View**: such a field adds `keys: string[]` (the record's keys that are set; keys are item
  names, not secret values; other secret records keep echoing `set` only).
- **PUT** `…/admin/extensions/:name/config` body gains
  `secretEntries?: { path: string; key: string; value?: string | null; renameFrom?: string }[]`:
  `value` string = set, `null` = remove, `renameFrom` = move an existing value to `key` (renaming an
  endpoint keeps its key). Applied inside the existing save transaction under
  `PluginDeploymentConfigLock`: decrypt, apply, re-encrypt the whole record, then validate the merged
  config as today. A path given by the startup config → 409 `extension.config_readonly`; a path not
  named by a hint → 400 `validation_failed`. The audit lists `apiKeys` in `changedPaths`, no keys.
- Org config and channel connections do not get entry operations now: no official plugin needs a
  record secret there, and `validateConfigUi` rejects `secrets` at those levels.

### 4.4 Issues

`ConfigIssue` gains `segments: (string | number)[]` (the zod path unjoined: endpoint names may
contain dots, so `apiKeys.a.b` is ambiguous) and `messageKey?: string`, set when a custom issue
carries `params.ui` naming a root `x-ui.messages` key. Messages stay generated, never zod's custom
text (it may contain values); the localized text comes from the hints. Same for org config and
channel connection errors.

### 4.5 Static schema for unloaded extensions

`staticDeploymentSchema` (no imported module on this replica: pending approval, disabled, import
failed) gives only `{ path, secret, hot }` today, so those extensions get the flat form. The packer
writes the JSON Schemas into the package: `extension.configSchemas: { deployment?: JsonSchema;
org?: JsonSchema }` in `plugin.json` (beside `manifest`, ≤ 96 KiB each as compact JSON; the packed
`plugin.json` text as a whole is ≤ 256 KiB, `PLUGIN_MANIFEST_LIMITS.manifestChars`, which the
packer checks on the pretty-printed text it writes). The kernel returns it as `schema` with
`validated: false` (unchanged semantics: no validation until load). It is **not** part of the
`manifest_mismatch` comparison: the packer's and the host's zod may serialize slightly
differently, and the field list in `manifest.config` already pins the shape. Old packages without
`configSchemas` keep today's flat fallback. A package using `ui()` needs an `sdk` range that
includes this SDK release, so older kernels refuse it by the SDK range before reading the section.

Ruling (final review): a plugin packed with the new plugin-tools that declares config carries
`extension.configSchemas` even when it uses no `ui()` (its `sdk` range may still admit an older
SDK). An older kernel's strict section parser refuses such a package with an "unrecognized key"
error instead of through the SDK range. This is acceptable before 1.0: the kernel and the plugins
move together (the bootstrap pins and the official marketplace are released in step), so a
deployment upgrades the kernel before it imports plugins packed by the new toolchain.

## 5. Web renderer

### 5.1 Structure

- **`packages/design`** (styles live only here) gets three components, each with a `docs/design/spec.md`
  entry (state list, size table), a `/dev/ui/reference` page and fidelity tests:
  - **`Repeater`** (§6.24): a list of item cards; header with title / subtitle (from the template),
    a drag handle and move up / down buttons (`reorder`), a remove `IconButton` with an undo toast;
    footer "Add …" button, or a `Menu` of presets plus "Blank"; empty and min / max states; an item
    card can collapse; keyboard: move with Alt+↑/↓, focus goes to the new item's first field.
  - **`FieldRow`** (§6.25): a compact row of small fields for `layout: "row"` (labels above on the
    first row only, wraps to a stack below the form's narrow breakpoint); checkboxes in a row are a
    group; an "Advanced" `Disclosure` per row.
  - **`KeyValueEditor`** (§6.26): rows of key / value inputs for records of scalars without hints.
  - Existing pieces are reused: `FormSection`, `Field`, `Input`, `Select`, `RadioGroup`, `Checkbox`,
    `Switch`, `Segmented` (tristate: Default / On / Off), `Disclosure`, `Badge`, `Callout`.
- **`apps/web/src/components/config-form/`** (no styles, design components only):
  - `model.ts` (pure): JSON Schema + `x-ui` → a node tree (object / array / record / scalar / secret
    / item-secret / json fallback), ordering and sections, draft ⇄ value, required and type
    validation, issue mapping;
  - `ConfigForm.tsx`: draws the tree; per-path meta `{ readonly?: source; secretSet?: boolean;
    secretKeys?: string[]; hot?: boolean }` comes from the adapter;
  - adapters: `deployment.ts` (fields, sources, `hot`, `secretEntries`), `org.ts` and `channel.ts`
    (whole-object config, `secrets: [{ path, set }]`, keep / clear / replace semantics).
- `SchemaForm.tsx`, `flatConfigSchema` and the `x-secret-json` stopgap (4151dfe5) are removed; every
  caller moves: admin extension config, org extension settings, channel create / edit, the catalog
  install wizard and the plugin upgrade dialog.

### 5.2 Behaviour

- **Labels** from `x-ui.label` in the page locale; without hints, `title`, else the field key (as
  today). Help, placeholder and unit likewise. Enum options show `options[].label` and `help`.
- **Arrays of objects** → `Repeater`; nested arrays nest (endpoint → models). Arrays of scalars →
  `tags` or a one-per-line list. Records of scalars → `KeyValueEditor`. Unions, tuples and
  `x-unsupported` keep the JSON textarea, now per node rather than per top-level field.
- **Item secrets**: inside each item a password input for `path[item[keyBy]]`: "Set" badge with
  Replace / Clear when the key is in `keys`, else empty. Renaming the item sends `renameFrom`;
  removing it sends `value: null`; the record field itself is not drawn on its own.
- **Read-only from the startup config**: a field given by file / Nacos / env renders read-only with
  its source badge; for an array, add / remove / reorder are disabled for the whole subtree.
- **Hot vs reload**: the form footer says whether saving reloads the extension (any changed non-hot
  field) and for how long at most (`drainSeconds`), as today; hot fields carry a small "applies
  immediately" note.
- **Validation**: client-side required / type / min / max per node before sending; server issues map
  by `segments` to the node (`endpoints.0.models.1.documents` → the second model row of the first
  endpoint card, which expands; `apiKeys.<name>` → that endpoint's key input; an array-level issue
  → the repeater). Unmappable issues go to the form-level error. `messageKey` picks the hint
  message, else the generic message.
- **Presets** prefill a new item and focus its first empty required field. They are the first step
  of the future "add model service" wizard; no separate wizard now.
- **Pending config**: a pending-config extension's tab opens with the form and a callout listing the
  missing fields by label.
- First paint stays server-decided (SSR spec): the server page reads the config view, the client
  form gets it as `initial`.

## 6. Worked example: openai-compatible

```ts
const T = (zh: string, en: string) => ({ zh, en });
const flag = (zh: string, en: string, help?: LocalizedText) =>
  ui(z.boolean().optional(), { label: T(zh, en), widget: "checkbox", ...(help && { help }) });

const EndpointModelSchema = ui(
  z.object({
    id: ui(z.string().min(1), { label: T("模型 ID", "Model ID"), placeholder: "deepseek-chat" }),
    contextWindow: ui(z.number().int().positive(), {
      label: T("上下文窗口", "Context window"), unit: T("tokens", "tokens") }),
    maxOutputTokens: ui(z.number().int().positive(), {
      label: T("最大输出", "Max output"), unit: T("tokens", "tokens") }),
    vision: flag("图片", "Images"),
    documents: flag("PDF 文档", "PDF documents",
      T("仅通用与通义千问方言支持", "Only the generic and Qwen dialects accept PDF")),
    reasoning: flag("推理", "Reasoning"),
    caching: ui(z.boolean().optional(), { label: T("缓存", "Caching"), widget: "tristate",
      help: T("默认按方言", "Default follows the dialect"), advanced: true }),
    streamIdleTimeoutMs: ui(z.number().int().positive().optional(), {
      label: T("流空闲超时", "Stream idle timeout"), unit: T("毫秒", "ms"), advanced: true }),
  }),
  { layout: "row" },
);

const EndpointSchema = z.strictObject({
  name: ui(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), { label: T("名称", "Name"),
    help: T("对外模型 ID 为 <名称>/<模型 ID>", "Models are exposed as <name>/<model id>") }),
  baseUrl: ui(z.string().url(), { label: T("接口地址", "Base URL"), widget: "url",
    placeholder: "https://api.example.com/v1" }),
  dialect: ui(z.enum(["generic", "deepseek", "qwen", "ark"]), { label: T("方言", "Dialect"),
    options: [
      { value: "generic", label: T("通用（vLLM 等）", "Generic (vLLM, …)") },
      { value: "deepseek", label: T("DeepSeek", "DeepSeek") },
      { value: "qwen", label: T("通义千问（百炼）", "Qwen (Model Studio)") },
      { value: "ark", label: T("火山方舟", "Volcano Ark") },
    ] }),
  midConversationSystem: ui(z.boolean().optional(), { label: T("对话中途的 system 消息",
    "Mid-conversation system messages"), widget: "tristate", advanced: true }),
  models: ui(z.array(EndpointModelSchema).min(1).refine(uniqueIds, { params: { ui: "duplicateModel" } }), {
    label: T("模型", "Models"),
    item: { title: "{id}", addLabel: T("添加模型", "Add model"), reorder: true } }),
});

const DeploymentConfig = ui(
  z.object({
    endpoints: ui(z.array(EndpointSchema).min(1).refine(uniqueNames, { params: { ui: "duplicateEndpoint" } }), {
      label: T("端点", "Endpoints"),
      item: { title: "{name}", subtitle: "{baseUrl}", addLabel: T("添加端点", "Add endpoint"), reorder: true },
      secrets: [{ path: "apiKeys", keyBy: "name", after: "baseUrl", label: T("API 密钥", "API key"),
        help: T("留空则请求不带凭据（如内网 vLLM）", "Leave empty for services without a key (e.g. an internal vLLM)") }],
      presets: [
        { id: "deepseek", label: T("DeepSeek", "DeepSeek"),
          values: { name: "deepseek", baseUrl: "https://api.deepseek.com", dialect: "deepseek" } },
        { id: "qwen", label: T("通义千问（百炼）", "Qwen (Model Studio)"),
          values: { name: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", dialect: "qwen" } },
        { id: "ark", label: T("火山方舟", "Volcano Ark"),
          values: { name: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", dialect: "ark" } },
        { id: "generic", label: T("其他兼容服务", "Other compatible service"), values: { dialect: "generic" } },
      ],
    }),
    apiKeys: secret(z.record(z.string(), z.string().min(1))).default({}),
  }).superRefine(/* as today, with params: { ui: "pdfDialect" } and { ui: "unknownKey" } */),
  { messages: {
    duplicateEndpoint: T("端点名称重复", "Endpoint names must be unique"),
    duplicateModel: T("模型 ID 重复", "Model ids must be unique within an endpoint"),
    pdfDialect: T("该方言不支持 PDF，请取消勾选", "This dialect does not accept PDF; clear the box"),
    unknownKey: T("密钥没有对应的端点", "This key has no endpoint"),
  } },
);
```

The admin sees: "端点" with one card per endpoint (title = name, subtitle = base URL), fields name /
base URL / API key / dialect, an "Advanced" disclosure, and a "模型" repeater of compact rows (ID,
context window, max output, the flags); "添加端点" opens DeepSeek / 通义千问 / 火山方舟 / 其他兼容服务 /
blank. Presets carry no model rows: model ids and limits change too often to pin in a plugin release
(open question 2).

## 7. Other official plugins

All 13 plugins add `displayName`; plugins with config add labels and help in both languages (the
JSDoc comments become hints):

| Plugin | Config | What the hints add |
|---|---|---|
| object-store-s3 | endpoint, region, bucket, keys, `forcePathStyle`, `publicEndpoint` | sections "Connection" / "Credentials" / "Browser access", URL widgets, help for path style and public endpoint |
| anthropic, openai | `apiKey`, `baseUrl`, `models` (string array), `serverFallbacks` | `models` as tags, enum labels |
| sandbox-docker | endpoint, `runtime`, network, images, volume driver, `allowOpenEgress` | runtime options (runc / gVisor) with help, the egress switch with its warning, advanced fields |
| sandbox-e2b | `apiKey`, `apiUrl`, `domain`, `template`, `timeoutSeconds`, flags | units (s), advanced self-hosting fields |
| lark, slack | deployment login app, org directory config, channel connection (`appId`, `appSecret`, `encryptKey`, `verificationToken`) | labels, help pointing to the developer console page, a "Webhook inbound only" section |
| connector-mcp, connector-openapi | `allowInsecureLoopback` | label and the dev-only warning |
| todo, example-* | none / examples | `displayName` only (example-counter shows hints as the reference) |

## 8. Release steps (cross-repo)

1. **Core, this acceptance batch** (`fix/rc2-acceptance`): SDK (`ui`, `configJsonSchema`,
   `validateConfigUi`, `LocalizedText`, the `secret()` merge), `pnpm gen:sdk-api`, a changeset bumping
   `@capybara-hq/plugin-sdk`, and changesets for kernel, plugin-tools and `@capybara-hq/capybara`
   (web is in its fixed group); kernel (§2, §4, the migration); plugin-tools (pack writes
   `configSchemas`, the checks of §10); design components with spec entries; the web renderer;
   `model-fake` gets `displayName`. Released as the next rc.
2. **Plugins repo PR**: SDK devDependency and each extension's `sdk` range raised to that rc;
   `displayName` everywhere; hints (§6, §7); changesets; `capybara-plugin marketplace --write`;
   merged and published by its release workflow.
3. **Core pin move** (AGENTS.md "moving a pin"): `packages/kernel/bootstrap.json` versions and
   integrity of openai-compatible and object-store-s3, `marketplace.commit` and the compose sandbox
   build contexts at that commit; `pnpm check:bootstrap --network` green; the openai-compatible e2e
   (§9) joins here, since e2e installs the bootstrap pins from npm.

## 9. Tests

- **SDK**: `ui()` merges with `secret` / `hot` in either order; `configJsonSchema` emits `x-ui`,
  `x-hot`, `x-secret`, fills `title` / `description`; one red case per `validateConfigUi` rule.
- **Kernel**: pass-through for deployment, org and channel schemas; scrub removes options / presets
  under secrets; invalid hints stripped at load with a warning, extension still loads; static
  `configSchemas` served when the module is not imported (pending approval, disabled); `secretEntries`
  set / clear / rename / readonly 409 / unhinted path 400, concurrent saves serialized, audit without
  keys; `keys` only for hinted paths; issues carry `segments` and `messageKey`; `displayName` in the
  admin list, org list, models list; the migration on a database with existing packages.
- **plugin-tools**: pack writes `configSchemas` reproducibly; pack refuses invalid hints; check rules
  red on fixtures.
- **Web**: `model.ts` (tree, ordering, sections, draft ⇄ value, issue mapping incl.
  `endpoints.0.models.1.documents` and `apiKeys.<name.with.dots>`); adapters' patches (only changed
  paths; secret entries for add / rename / remove of an endpoint); `ConfigForm` renders without
  hints as well as today; the first render does no fetch.
- **Design**: reference pages, fidelity (size tables, state lists) and interaction specs for
  `Repeater` (add, preset menu, remove with undo, keyboard reorder, focus) and `FieldRow` (wrap).
- **e2e**: in step 1, a fixture extension `fake-config-form` (`packages/testing/fixtures/extensions`,
  an openai-compatible-shaped schema with hints) configured through the admin form; in step 3,
  `admin-extensions.spec.ts` configures openai-compatible: add the DeepSeek preset, set its key, add
  a model row, save, then the agent model select shows "OpenAI 兼容 / deepseek/<model>" (fake model
  server, `startFakeModelServer`, as the baseUrl).

## 10. Checks (red first)

| Rule | Where | Runs | What fails |
|---|---|---|---|
| `plugin-config-ui` | `capybara-plugin check` ("Config forms"), core `pnpm check` | full (cheap: one import per plugin, as "Plugin pack") | `validateConfigUi` problems in a plugin's deployment / org schema |
| `plugin-config-labels` | same | full | a public plugin with a config schema whose rendered field has no `label` (zh and en), skipping secret records drawn per item |
| `release-display-name` | `plugin-release-metadata` | full | a public plugin's `plugin.json` without `displayName` |
| `web-ui` (extended) | `check:web-ui` | full | `${…provider} / ` style labels built outside `extensionLabel` in `apps/web/src` |

Each rule gets a red fixture (`packages/plugin-tools/fixtures/`, `tools/checks/fixtures/`) and the
AGENTS.md CI section lists them.

## 11. Compatibility

- Extensions without hints get the structured generic form; labels fall back to keys as today.
- Packages packed before this change have no `configSchemas`: unloaded ones keep the flat fallback.
- The deployment config PUT body only gains an optional field; the view only gains fields
  (`displayName`, `keys`, `segments`, `messageKey`), so the CLI and older web builds keep working.
- `hot` moves from `hot` to `x-hot` in the JSON Schema; the web is the only reader and changes in the
  same release.
- Packages packed by the new plugin-tools that declare config carry `extension.configSchemas`, which
  an older kernel refuses ("unrecognized key" from its strict section parser) rather than by the SDK
  range: accepted before 1.0, since the kernel and the plugins move together (§4.5 ruling).

## 12. Out of scope

- Extension-supplied config UI code (custom components, embeds) for config.
- Conditional visibility (`documents` only for PDF-capable dialects); the dialect rule stays a
  validation message on the field.
- "Test connection" buttons and fetching an endpoint's model list.
- Record secret entry operations for org config and channel connections.
- Localizing model display names (`ModelInfo.displayName`).
- A separate "add model service" wizard (presets are its first step).

## 13. Decisions

| # | Decision | Source |
|---|---|---|
| F1 | Schema + declarative hints drawn by one web renderer; extensions ship no config UI code | user 2026-11-02 |
| F2 | Localized display name everywhere, id as muted meta; all official plugins set `displayName` | user 2026-11-02 |
| F3 | Hints via `ui(schema, hints)` stored as zod meta `ui`, serialized as `x-ui`; `secret()` and `ui()` merge meta | this spec |
| F4 | `configJsonSchema` and `validateConfigUi` live in the SDK; packer, checks and kernel share them | this spec |
| F5 | Secrets stay at fixed object paths; `secrets[]` draws a record entry per array item, saved through `secretEntries` | this spec |
| F6 | Invalid hints: the packer refuses, the kernel strips them and loads | this spec |
| F7 | The packer writes `configSchemas` so unloaded extensions get the rich form; excluded from `manifest_mismatch` | this spec |
| F8 | Extension display name stored on `extension_packages`, catalog item as fallback, no backfill | this spec |
| F9 | Deployment, org and channel forms share one renderer; `SchemaForm` and the JSON-secret stopgap go | user 2026-11-02, this spec |
| F10 | Presets are the first step of the later "add model service" wizard; no wizard now | user 2026-11-02 |

## 14. Open questions

1. **Record keys in the view** (§4.3): the view lists which endpoint names have a key set. They are
   names the admin typed, not secrets; acceptable?
2. **Model rows in presets** (§6): presets fill name / base URL / dialect only. Should DeepSeek /
   Qwen / Ark presets also add their current models with limits, accepting a plugin release when
   vendors change them?
3. **`plugin-config-labels` strictness** (§10): required for every public plugin from the start
   (all official plugins get labels in step 2), or a warning first?
