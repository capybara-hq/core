# Client extensions: plugin components, replacement slots and decoration (UI customization L2 / L3)

- Date: 2026-11-09, written against `feat/client-extensions` at `52279a17` (stacked on
  `feat/ui-slots`; latest kernel migration 0103).
- Status: implemented on `feat/client-extensions` (2026-11-09, final fix wave 2026-11-10); the code is the source of truth and §17 lists every place this text was adjusted to it. Decided under the maintainer's 2026-11-09 autonomy grant.
- Related: themes (`2026-11-08-themes-design.md`, L0, merged), UI slots
  (`2026-11-08-ui-slots-design.md`, L1, §3.3 reserves the fields this spec fills), plugin component
  management (`2026-11-05-plugin-component-management-design.md`: owner, scope, org uploads), the
  extension UI contract (`.agents/skills/writing-extension-ui/SKILL.md`), the extension host and
  permission review (`.agents/skills/writing-extensions/SKILL.md`,
  `packages/kernel/src/extensions/permission-set.ts`, `permission-view.ts`), the plugin format
  (`.agents/skills/writing-plugins/SKILL.md`, `packages/plugin-sdk/src/plugin-manifest.ts`,
  `packages/plugin-tools/src/pack/pack.ts`), the web rules (`.agents/skills/writing-web-ui/SKILL.md`),
  the design spec (`docs/design/spec.md` §1-§4), the `Platform` tool (`check:platform-ops`).
- Markers: **(decided, 2026-11-09)** is the maintainer's answer (D1-D4); **(decided by Claude
  under the 2026-11-09 grant)** is a controller ruling taken under the maintainer's autonomy grant
  (C1-C9), binding unless this spec records a change with evidence (§17); **(designer's call)** is
  decided here and may be overturned in review. Items without a marker restate current code,
  AGENTS.md rules or the two specs this builds on.

## 1. Why

The themes spec (§1) studied the best-known DeepSeek Harness restyle, `dsh-theme-cyberpunk2077`.
Its palette came from one official API; everything else was raw DOM work by a full-trust client
plugin: a 400-line injected `<style>` with `!important`, selectors on CSS-module class fragments
(`[class*='_sessionRow']`), polling the DOM for the composer's pending dot, overlays appended to
`body`, fonts from a CDN. It broke whenever DSH changed its markup.

The lesson is not "forbid the hacks" but **turn every hack into a contract**: each thing the DSH
plugin needed becomes a named, versioned surface the core promises to keep.

| DSH hack | Capybara contract | Layer |
|---|---|---|
| Token overrides | Themes (tokens, fonts, logo) | L0 (merged) |
| Panels injected next to the chat | Slots with views and embeds | L1 |
| React components mounted into the page | `component` contributions from a client bundle | **L2** (this spec) |
| Replacing the logo / greeting by DOM surgery | Replacement slots (`cardinality: "single"`) | **L2** (this spec) |
| `[class*='_sessionRow']` selectors | `data-cap-part` style hooks from a catalog | **L3** (this spec) |
| Polling the DOM for "is it running" | `data-cap-state` state hooks, client events | **L3** (this spec) |
| Overlays appended to `body` | The `shell.overlay` slot | **L3** (this spec) |
| A `<style>` with `!important` | Plugin CSS in `@layer extensions` | **L3** (this spec) |
| Fonts from a CDN | Theme fonts (L0); no remote `@import` / `url()` in plugin CSS | L0 / L3 |

Four layers **(decided, 2026-11-09, D1)**: L0 themes, L1 slots, L2 client components, L3
decoration. Replacement slots (a plugin replaces a built-in block, up to a whole-page override) are
in scope now; the whole-page override itself is a follow-up (§16).

## 2. Goals, non-goals, anti-goals

Goals:

1. A plugin's extension can carry **client code**: one browser ES module and optional CSS files and
   assets, built by `capybara-plugin pack`, reviewed with the extension, delivered only where the
   plugin is on.
2. Client code renders **React components in slots** (kind `component`) with typed props per slot
   and hooks for the plugin's own views and actions, access, locale, run state, client events and
   reduced motion.
3. Some slots are **replaceable**: a built-in block with a default that one chosen contribution
   replaces (`shell.brand`, `conversation.empty`, `conversation.composer.frame`).
4. **Decoration without DOM hacks**: stable part names (`data-cap-part`), state attributes
   (`data-cap-state`), an overlay slot and client events, enough for scanlines, chamfered borders,
   a boot animation, a run-state colour change and optional sound.
5. **The official UI is always one step away**: safe mode per page, a super-admin kill switch,
   per-component error boundaries, a crash budget.
6. The `theme-cyberpunk` acceptance of D4 (§15) uses only these contracts.

Non-goals:

- A sandbox for client code. Client code runs in the page with full trust and can read everything
  the page shows **(decided, 2026-11-09, D2)**; approval is governance, as for server extensions.
- Forcing design components or tokens on plugins **(decided, 2026-11-09, D3)**. The re-exported
  design subset is a convenience with a version, not a requirement.
- Whole-page override (`page.override`), plugin-provided web routes, client code for orgs on
  unconfirmed plugins **(decided by Claude under the 2026-11-09 grant, C9)**.
- Plugin client code on the auth pages, the org chooser, the setup frame, the root error and
  not-found pages (designer's call: they sit outside the workspace layout and must always work).

Anti-goals (failure even if it works):

- A core change that silently breaks a plugin using only contracts (a part renamed, a slot's props
  changed, an event payload changed) without a version bump and a release note.
- A crashing or slow plugin that leaves a person without a working conversation page.
- A super admin unable to reach the admin console because of an org's client code.
- Client code served to someone outside the orgs where its plugin is on.
- Raw DOM edits being treated as supported: they work, but outside the compatibility promise (D3).

## 3. Terms (UI)

| Term | Meaning |
|---|---|
| 客户端代码 Client code | The browser bundle, CSS files and assets of a plugin's extension (the `client` entry) |
| 客户端组件 Client component | A `component` contribution: a React component from the client code, rendered in a slot |
| 替换位 Replaceable slot | A slot with `cardinality: "single"`, a built-in default and `replaceable: true` |
| 装饰 Decoration | Plugin CSS on part and state hooks, and components in `shell.overlay` |
| 部件 Part | A built-in element named in `UI_PARTS` and marked `data-cap-part="<name>"` |
| 安全模式 Safe mode | A page load with no client code (`?safe-ui=1`) |
| 客户端代码总开关 Kill switch | The deployment setting `clientExtensions.enabled` |

The zh UI keeps 平台 / 超级管理员 / 智能体 and never says 企业 or `agent` (`pnpm check:i18n`).

## 4. The client entry and `@capybara-hq/plugin-client`

### 4.1 Packaging (decided by Claude under the 2026-11-09 grant, C1)

- A plugin with an extension may have `src/client.tsx` (or `.ts`). `capybara-plugin pack` builds it
  with esbuild (`platform: "browser"`, `format: "esm"`, `target: "es2022"`, minified, one file, JSX
  `automatic`) into `package/dist/client/client.mjs`, and copies `client/styles/*.css` into
  `package/dist/client/styles/` and `client/assets/**` into `package/dist/client/assets/`.
- **Externals**: `react`, `react-dom`, `react/jsx-runtime` and `@capybara-hq/plugin-client`. They
  are provided by the host through an import map (§9.4). Every other import is bundled; the packer
  fails with `client-import-forbidden` when the metafile shows an unresolved bare import, a Node
  builtin, `react-dom/server`, a dynamic `import()` of a non-relative URL or any
  `@capybara-hq/*` other than `plugin-client`. The bundle is self-contained.
- The packer writes the section into `plugin.json` (`PluginExtensionSection`, never by hand):

```ts
interface PluginExtensionSection {
  entry: string;               // "./dist/index.mjs" (unchanged)
  manifest: StaticExtensionManifest;
  migrations?: string;
  ui?: string;
  configSchemas?: { deployment?: JsonSchema; org?: JsonSchema };
  client?: PluginClientSection; // new
}

interface PluginClientSection {
  /** "./dist/client/client.mjs"; absent for CSS-only decoration. */
  entry?: string;
  /** "./dist/client/styles/<name>.css", in injection order. */
  styles?: string[];
  /** Files under "./dist/client/assets/". */
  assets?: string[];
  /** sha384 of every file above, keyed by its path: "sha384-<base64>". */
  integrity: Record<string, string>;
  /** CLIENT_API_VERSION the bundle was built against. */
  apiVersion: number;
}
```

- A `client` section needs at least an entry or one style file, and an extension
  (`client` lives in the extension section; a themes-only plugin has none).
- **Limits** (`CLIENT_LIMITS` in the SDK, designer's call): `entryBytes` 1 048 576; `styleFiles` 8;
  `styleBytes` 262 144 each; `assetFiles` 64; `assetBytes` 2 097 152 each; `totalBytes` 8 388 608
  for the whole client section. Asset types: `.png`, `.webp`, `.svg`, `.woff2`, `.mp3`, `.ogg`,
  `.wav`.
- **File names**: every segment of a client file path (`styles/<name>.css`, `assets/<path>`) is made
  of `[A-Za-z0-9._-]` and is not `.` or `..`; files are known only by their exact manifest key
  (`./dist/client/<path>`), never a decoded or joined path.
- **CSS files**: the packer wraps each file in `@layer extensions { … }` (§7.2) and fails with
  `client-css-remote` when the file:
  - contains `@import` (however spelled; a remote sheet is not integrity-pinned);
  - has a `url()` (token or string, escapes decoded, CSS whitespace trimmed) that is not exactly
    `../assets/<path of one of the plugin's assets>`, a `data:` URL or a `#fragment` (any other
    relative URL is refused too: the sheet is served from `/api/v1/client/<plugin>/<build>/styles/`,
    so `../../…` would reach kernel routes with the viewer's cookies);
  - calls `image-set`, `-webkit-image-set`, `cross-fade`, `-webkit-cross-fade`, `element`,
    `-moz-element`, `paint`, `src` or `image` (case-insensitive, escapes decoded): they take URLs
    from plain strings or `var()`, or reach outside the sheet; write `url(../assets/x.png)`;
  - contains an invisible character anywhere, escaped or not: non-ASCII whitespace (U+0085,
    U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000), a zero-width character
    (U+180E, U+200B-U+200D, U+2060) or U+FEFF (JavaScript's `trim()` strips an NBSP that CSS and
    the URL parser keep, so `url("\a0 data:/../../v1")` would pass a naive check).

  The rule is one pure module in the SDK (`packages/plugin-sdk/src/client-css.ts`: `clientCssProblem`
  checks, `wrapClientCss` wraps; shared vectors in `packages/plugin-sdk/test/fixtures/client-css-vectors.json`).
  The packer and the kernel both import it, so pack and import cannot disagree: the kernel re-checks
  the stored bytes with a tokenizer that follows CSS Syntax (comments, strings, escapes, url tokens)
  and requires the file to be exactly one `@layer extensions { … }` block (§7.2). It warns `client-css-selector` on a selector that is
  not built from `[data-cap-part]`, `[data-cap-state]`, the plugin's own classes (prefix
  `cx-<plugin>-`), `:root` custom properties named `--cx-<plugin>-*`, or reads of `--cb-*` tokens;
  the warning is advice, not enforced at runtime (D3).
- `capybara-plugin check` gains `client-import-forbidden`, `client-css-remote`, `client-size`,
  `client-api-version` (the packed section's `apiVersion` is not the toolchain's `CLIENT_API_VERSION`),
  `client-undeclared`, `appearance-invalid` (errors) and `client-css-selector`, `ui-part-unknown` (warnings: a
  `data-cap-part` value not in `UI_PARTS`).
- A **bootstrap plugin may not carry client code** (designer's call): bootstrap
  packages may be stored in PG before an object store runs (`extension_packages.blob_store = 'pg'`),
  and client files are delivered from object storage (§9.1). Both halves enforce it: the kernel
  refuses a bootstrap source with `extension.client` (400 `client.invalid`, naming the plugin,
  whether or not an object store runs) and `check:bootstrap` reports `bootstrap-client-code`
  (workspace entries offline; npm entries in the network mode, from the fetched tarball).

### 4.2 The package (decided by Claude under the 2026-11-09 grant, C2)

`@capybara-hq/plugin-client` (new, published, Apache-2.0) holds the types, `defineClientExtension`,
`defineComponent`, the hooks and the design re-exports. Its dependencies: `react` (peer) and
nothing from `@capybara-hq/*` (the slot and part catalogs it needs are generated copies, like the
web's, drift-checked by `check:ui-slots` / `check:ui-parts`).

In the browser the specifier `@capybara-hq/plugin-client` resolves, through the import map, to
the **host's implementation** of the same interface (§9.4); the package's own runtime is what
tests and type checking use (`@capybara-hq/plugin-client/testing` provides a fake host). The
host's export list and `CLIENT_API_VERSION` are generated into apps/web from the package
(`pnpm gen:plugin-client`, drift-checked by `check:plugin-client-api`), because `apps/web` depends
only on `@capybara-hq/design` (AGENTS.md).

```ts
export const CLIENT_API_VERSION = 1;

/** The slots that accept `component` (generated from UI_SLOTS). */
export type ComponentSlotId =
  | "conversation.panel" | "conversation.properties.section" | "conversation.tool-result.card"
  | "org.page" | "agent.detail.section" | "org.settings.section" | "platform.page"
  | "shell.brand" | "shell.overlay" | "conversation.empty" | "conversation.composer.frame";

/** Props every component receives, plus its slot's own (§5.3). */
export interface BaseComponentProps {
  plugin: string;
  contribution: string;
  slot: ComponentSlotId;
}

export type ComponentProps<S extends ComponentSlotId> = BaseComponentProps & SlotComponentProps[S];

export interface ClientComponent<S extends ComponentSlotId = ComponentSlotId> {
  readonly slot: S;
  readonly render: React.ComponentType<ComponentProps<S>>;
}

/** Binds a component to the slot it is written for; the host checks it against the manifest. */
export function defineComponent<S extends ComponentSlotId>(
  slot: S,
  render: React.ComponentType<ComponentProps<S>>,
): ClientComponent<S>;

export interface ClientExtensionDefinition {
  /** Equals the plugin (and extension) name. */
  name: string;
  /** Keyed by the `component` contribution id of the extension manifest. */
  components?: Record<string, ClientComponent>;
  /** Listeners alive while the extension is loaded (sound, analytics of the plugin's own). */
  events?: Partial<{ [K in CapybaraEventType]: (e: CapybaraEventOf<K>, api: ClientApi) => void }>;
}

export interface ClientExtension extends ClientExtensionDefinition {
  readonly apiVersion: number; // CLIENT_API_VERSION at build time
}

/** The entry module's default export. */
export function defineClientExtension(def: ClientExtensionDefinition): ClientExtension;

/** The viewer's sign-in as this plugin sees it (§9.2 `signInId`). */
export interface SignIn {
  /** Opaque: the same for one sign-in (every page and tab, across token refreshes), new after
   *  the next sign-in; no credential, reveals nothing else about the session. Derived per
   *  plugin, but no isolation boundary: client code is full trust (D2) and can read every
   *  plugin's id from the shell read. */
  id: string;
}

/** What `events` listeners get (no React context there). */
export interface ClientApi {
  locale: "zh" | "en";
  reducedMotion: boolean;
  storage: ClientStorage;
  assetUrl(path: string): string;
  signIn: SignIn;
}
```

Hooks (usable only inside a component the host rendered; they read the host's React context,
never globals; outside it they throw `PluginClientContextError`):

```ts
/** The view the extension registered under this component's id (ctx.ui.view), refreshed by
 *  ctx.ui.invalidate like any view; args are the slot's (§5.2). */
export function useView(): {
  view: UiView | null; // includes `data` (§5.2)
  status: "loading" | "ready" | "failed";
  retry(): void;
};

/** Calls ctx.ui.action registered under this component's id. */
export function useAction(): (
  actionId: string,
  input?: { payload?: JsonValue; answer?: Record<string, unknown> },
) => Promise<{ view?: UiView; toast?: string }>;

export function useAccess(): {
  orgId: string | null;              // null on platform pages
  role: "owner" | "admin" | "member" | "guest" | "superAdmin";
  atLeast(role: "guest" | "member" | "admin" | "superAdmin"): boolean;
};

export function useLocale(): { locale: "zh" | "en"; t(text: { zh: string; en: string }): string };

export type RunState = "idle" | "running" | "waiting" | "failed";
/** The open conversation's run state; "idle" on pages without a conversation. */
export function useRunState(): { state: RunState; conversationId: string | null };

/** Calls `handler` for each client event (§7.5); `types` filters. */
export function useCapybaraEvents(
  handler: (e: CapybaraEvent) => void,
  types?: readonly CapybaraEventType[],
): void;

export function usePrefersReducedMotion(): boolean;

/** The resolved theme (themes spec §7): `key` is "<plugin>/<theme file id>", null = built-in. */
export function useTheme(): { key: string | null; scheme: "dark" | "light" };

/** localStorage / sessionStorage under the prefix "cap-ext:<plugin>:"; reads and writes never
 *  throw (a blocked store reads as empty). */
export interface ClientStorage {
  get(key: string, scope?: "local" | "session"): string | null;
  set(key: string, value: string | null, scope?: "local" | "session"): void;
}
export function useClientStorage(): ClientStorage;

/** URL of a file under dist/client/assets/ of this plugin's build. */
export function useAssetUrl(): (path: string) => string;

/** The viewer's sign-in: once per sign-in = run when `id` differs from the id stored last time
 *  (`useClientStorage`, scope "local"). */
export function useSignIn(): SignIn;
```

Design re-exports (a versioned subset; their props are the design system's, frozen per
`CLIENT_API_VERSION`): `Button`, `Badge`, `Icon`, `KeyValue`, `Kbd`, `Logo`, `Spinner`, `Stack`,
`Text`, `Tooltip`, `PropertySection`, and `ViewBlocks` (the host's renderer of a `UiView`, the one
`ExtensionViewTab` uses). Adding one is compatible; removing one or changing its props needs
`CLIENT_API_VERSION` 2.

**Versions**: the host accepts a bundle whose `apiVersion` equals its own `CLIENT_API_VERSION`
(the host stamps its own version into the import map, so the bundle's declared `apiVersion` is a
check the web repeats, not the real gate);
while the host moves from N to N+1 it implements both for one minor release after 0.1.0 (before
0.1.0 no compatibility layers, AGENTS.md). **The kernel's gate is authoritative**: an import
refuses a section whose `apiVersion` is above the SDK's `CLIENT_API_VERSION` (`client.api_unsupported`,
400, details `{ apiVersion, supported }`), and neither the shell reads nor the delivery route (§9.3)
offer a build whose `api_version` the running kernel does not support, so the web never sees one. A bundle the host still cannot run (a
mismatch the web detects itself) is not activated and is reported (`kind: "api"`, §10.4).

## 5. The `component` kind and permissions

### 5.1 Contributions (decided by Claude under the 2026-11-09 grant, C3)

`UiContribution` gains `kind: "component"`:

```ts
ui: [
  { id: "run-hud",  title, slot: "conversation.properties.section", kind: "component", after: "context" },
  { id: "brand",    title, slot: "shell.brand",                     kind: "component" },
  { id: "scanlines", title, slot: "shell.overlay",                  kind: "component" },
],
permissions: {
  client: true,
  ui: { components: ["run-hud", "brand", "scanlines"] },
},
```

- Structural validation (`validateUiContributions`, throws at `defineExtension` and at load): a
  `component` id is listed in `permissions.ui.components` and the reverse; an id is in at most one
  of `views` / `embeds` / `components`; `path` is refused on components; a component to a slot the
  catalog knows that does not accept `component` is a structural error, as for the other kinds.
- `permissions.client: true` is required exactly when the package has a `client` section: the
  packer sets the section only when the manifest declares it (`client-undeclared` otherwise), and
  the kernel's import refuses a package whose section and manifest disagree (`client.undeclared`,
  400). A manifest with `ui.components` needs `client: true`.
- Slot resolution is L1's (`resolveUiSlots`): an unknown slot or version drops the contribution
  with a reason; the extension still loads.
- Slots that accept `component`: `conversation.panel`, `conversation.properties.section`,
  `conversation.tool-result.card`, `org.page`, `agent.detail.section`, `org.settings.section`,
  `platform.page` (C3), and the four new slots of §6.2. `file.preview` does not (previewers stay
  embeds of `file-preview@1`).
- `ToolResult.card` may name a `component` contribution of `conversation.tool-result.card`: the
  pipeline's `inlineViews` set (`ToolPipelineDeps`) includes them.

### 5.2 Server views for components

- A component may have a server side: `ctx.ui.view(<component id>, render)` and
  `ctx.ui.action(<component id>, handler)` are allowed when the id is in `permissions.ui.views` or
  `permissions.ui.components` (`perm-ui` of `check:extension-permissions` accepts both).
- The views, actions and refresh routes treat a component like a view of its slot: the slot's
  `minRole` and scope rule (UI slots spec §7) decide access, and the args are the slot's scope
  args (a component in `conversation.properties.section` gets `conversationId`; shell slots get
  none: their scope is `org`).
- `UiView` gains `data?: JsonValue`, accepted only from a component's render, at most
  `UI_LIMITS.componentDataBytes` = 32 768 bytes of JSON (`ui.invalid_view` otherwise). A
  component's view may have no blocks. Views of the other kinds keep refusing `data`.
- **Props carry page data; server calls follow the slot's scope**: what a component receives as
  props (§5.3) is what the page already shows; anything the server must authorize goes through
  `useView` / `useAction`, checked by the kernel.

### 5.3 Props per slot

```ts
interface SlotComponentProps {
  "conversation.panel": { conversationId: string; item?: string; close(): void };
  "conversation.properties.section": { conversationId: string };
  "conversation.tool-result.card": { conversationId: string; card: { callId: string; key?: string } };
  "org.page": Record<string, never>;
  "agent.detail.section": { agentId: string };
  "org.settings.section": Record<string, never>;
  "platform.page": Record<string, never>;
  "shell.brand": { builtin: React.ReactNode; collapsed: boolean; panel: "full" | "rail" | "drawer" };
  "shell.overlay": Record<string, never>;
  "conversation.empty": { builtin: React.ReactNode; agentId: string | null; greeting: string };
  "conversation.composer.frame": {
    builtin: React.ReactNode;     // the built-in frame with the composer inside
    children: React.ReactNode;    // the built-in composer inputs, without the frame
    conversationId: string | null; // null on the new-conversation page
    runState: RunState;
  };
}
```

`conversation.composer.frame`: `builtin` is the composer **with** the built-in frame, `children` the
composer inputs **without** it, so a plugin that draws its own frame renders `children` inside it,
and one that only wraps renders `builtin`.

Components in **list slots** are drawn inside the host's frame (the section, panel, card or form
section views get; `ClientComponentBlock` takes the slot's `frame`, and the title comes from the
manifest) (C2): a plugin does not draw its own section, title or box there. Components in single
slots and the overlay draw whatever they like.

A replacement may render `builtin` (to wrap or decorate the default) or replace it entirely; the
composer frame must render `children` exactly once, inside the frame (the host checks after every
commit and on every DOM change inside the slot that it holds exactly one composer textarea: none,
two, or one portaled out of the frame all count as crashed, §10.3).

`shell.brand` receives `{ builtin, collapsed, panel }` where `panel` is `"full" | "rail" |
"drawer"`: the design `Sidebar` takes `brand` as a **function of the panel it is drawn in**
(`(v: { collapsed, panel }) => ReactNode`, called once per drawn panel), so the rail, the drawer and
the full sidebar each get their own node and a plugin never has to render one element twice.

### 5.4 Permission review

- New permission keys: `permissions.client` and `ui.component:<id>` (`permissionKeys`,
  `buildPermissionSet` gains `client` and `ui.components`).
- **Both are sensitive and block loading** (C3): `itemReason` marks `client` (new category,
  reason `client_code`) and `components` (its own category, items are the component ids, reason
  `ui_component`; the `ui` category keeps views and embeds); `isSensitivePermissionKey` follows
  from the same table. `blockingKeys` keeps exempting only
  `ui.view:*`.
- The org enablement page and the admin extension detail show a 客户端代码 group, highlighted, with
  the build's files and sizes (§9.1). `capybara extensions review` / `approve` mark both keys
  `(sensitive)`.
- **Org uploads (decided, 2026-11-09, D2)**: an org may upload a plugin carrying client code; it is
  a plugin with an extension, so it waits for the super admin (`awaiting_confirmation`, the
  existing branch of the component management spec §4.2) and its permission snapshot needs
  approval. Nothing is delivered before both (C9).
- An upgrade that changes only the client bundle and adds no key loads like any server-code
  change (the keys, not the bytes, are reviewed); an upgrade adding a component blocks until
  approved.

## 6. Replacement slots

### 6.1 Catalog fields (decided by Claude under the 2026-11-09 grant, C4)

`UiSlotSpec` (UI slots spec §3.1) fills the reserved fields:

```ts
interface UiSlotSpec {
  // … L1 fields …
  accepts: readonly ("view" | "embed" | "component")[];
  cardinality: "list" | "single";
  /** single slots only: a contribution may take the cell instead of the built-in default. */
  replaceable?: true;
  /** single slots only: what the built-in default is, for the arrangement UI. */
  builtin?: { en: string; zh: string };
}
```

- `cardinality: "single"` ⇒ `replaceable: true`, `builtin` set, `accepts` is `["component"]`, no
  `anchors`, no `limits` (catalog test).
- A replaceable slot always renders its built-in default unless a winner is chosen (§6.3).

### 6.2 The new slots

| Slot | Where (an existing region) | Cardinality | Scope / args | Accepts | Min role | Owner (apps/web/src) |
|---|---|---|---|---|---|---|
| `shell.brand` | the sidebar's brand row (`Logo` + wordmark; the rail's mark) | single, replaceable | org / — | component | guest | `components/shell/AppFrame.tsx` |
| `conversation.empty` | the new-conversation hero (`Greeting`) | single, replaceable | org / — | component | guest | `components/conversation/NewConversation.tsx` |
| `conversation.composer.frame` | the frame around the composer (`ComposerBox`), on the new-conversation and conversation pages | single, replaceable | org / — | component | guest | `components/conversation/ComposerBar.tsx` |
| `shell.overlay` | a full-viewport layer over the workspace shell (§7.4) | list, `maxShown: 4` | org / — | component | guest | `components/shell/AppFrame.tsx` |

- `shell.brand` needs the design `Sidebar` to take the brand row's content (`brand?: (v:
  SidebarBrandVariant) => ReactNode`, a function of the panel, default the `Logo` it draws today); `AppFrame` passes `<ExtensionSlot
  slot="shell.brand" …>` with the `Logo` as `builtin`. The theme's logo (L0) still reaches the
  built-in through the design context.
- `conversation.composer.frame`: one `ExtensionSlot` in `ComposerBar.tsx`, used by both pages;
  the inputs, attachments, send button and their behaviour stay built-in and arrive as `children`.
- `page.override:<route>` is deferred (C4, C9). The form `page.override:<route>` is not a valid
  slot id under `parseSlotRef` (`[a-z][a-z0-9-]*` segments joined by dots); the follow-up spec
  picks the shape (likely one slot `page.override` with a `route` arg).
- Not on the admin console: these slots are rendered only by workspace pages (§9.6).

### 6.3 Choosing the winner

- **The arrangement gains `use`** for single slots: `{ [slotId]: { use: string | null } }`, keyed
  `<extension>/<contribution>` (`UI_CONTRIBUTION_KEY_RE`); `hidden` / `order` are refused on a
  single slot and `use` on a list slot (400 `validation_failed`).
- Org admins set the org's (the 界面位置 section on `/extensions` gains, per
  replaceable slot, a select 内置 / each contribution); the super admin sets the platform default
  (平台设置 › 界面位置). Storage, merge and routes are L1's (`orgs.settings.uiArrangement`,
  `deployment_settings` key `uiArrangement`, per-slot replace, `null` removes the entry).
- **Resolution** (C4): the org's entry for the slot if present, else the platform's, else none.
  `use: null` or no entry = the built-in. A `use` naming a contribution that is not available in
  the org (extension off, dropped, the viewer's role below the slot's) = the built-in, never the
  other level's choice and never an error; the stored key is kept (the extension may come back).
- The contributions route lists, for a single slot, **at most the winner**; the web renders the
  built-in when the list is empty.
- `GET …/ui/arrangement` lists, per replaceable slot, the candidates, the current `use` and
  whether it follows the platform.
- Enabling a plugin never picks its replacement by itself (C4: default none); a plugin may
  suggest picks that an admin applies in one step (§6.5).

### 6.4 Fallback

- A winner that throws while rendering, fails to load, times out or breaks its slot's rule (the
  composer check of §5.3) is replaced **by the built-in** for that page (an error boundary around
  the slot keeps the built-in node ready); it is reported once per document (§10.4).
- While the winner's module is loading, the slot renders the built-in with `visibility: hidden`
  (design `ReplaceableFrame pending`, keeping the layout) for at most `CLIENT_LIMITS.pendingMs` =
  1 500 ms, then shows the built-in and swaps when the module arrives (designer's call: no flash of
  the official brand on a normal load, no blank brand on a slow one). The **server render** already
  draws the slot pending when the shell lists a delivered winner for it, and the frame's CSS reveals
  the built-in after 1 500 ms with no script at all, so a document whose scripts never run is never
  left blank (§17: this replaces the first draft's "the server render shows the built-in").
- In safe mode and under the kill switch, replaceable slots render the built-in. On the server
  render, and the first client render before the host has loaded, they render the built-in too
  (hidden when a delivered winner is listed, above), so hydration never mismatches.

### 6.5 Suggested appearance (decided by Claude under the 2026-11-09 grant)

A plugin may suggest how it should look when chosen; nothing applies on install or enable, and an
admin applies the suggestion in one confirmed step.

- `plugin.json` gains an optional top-level field (the author writes it; JSON Schema regenerated by
  `pnpm gen:package-schemas`):

```ts
interface SuggestedAppearance {
  /** A theme id (file base name) of this plugin. */
  theme?: string;
  /** Replaceable slot id → a `component` contribution id of this plugin's extension in that slot. */
  replacements?: Record<string, string>;
}
```

- Validation (`parsePluginManifest`, so pack, `capybara-plugin check` and the kernel's import agree):
  at least one of `theme` / `replacements`; `theme` names a theme the plugin carries; each
  `replacements` key is a slot ref (`parseSlotRef`) and each value a contribution id
  (`^[a-z][a-z0-9-]{0,39}$`); at most 8 entries; `replacements` needs an extension. For a slot the
  SDK knows, the slot must be `cardinality: "single"` and the value a `component` contribution of
  the extension's manifest in that slot (error `appearance-invalid`). A slot the SDK does not know
  is accepted and skipped when applied (the same rule as unknown slots, UI slots spec §3.2).
- There is no `decorations` field: decoration (plugin CSS, overlay) is on wherever the plugin is
  on, and scopes itself to its theme through `theme=` (§7.3), so there is nothing to opt into.
- **The action 应用此插件的外观 / "Apply this plugin's appearance"**:
  - the super admin, on the admin plugin detail (`/admin/plugins/<id>`):
    `POST /api/v1/admin/catalog/items/:id/appearance` (`@SuperAdmin`, human only) writes the
    platform default theme (`deployment_settings.uiTheme`) and the platform arrangement's `use`
    for each replacement slot;
  - an org admin, on the workspace 扩展 page (`/extensions`), for a plugin on in the org:
    `POST /api/v1/orgs/:orgId/extensions/:extension/appearance` (`@OrgAction("org.update")`) writes
    the org default theme (`orgs.settings.theme.id`, keeping `personal`) and the org arrangement's
    `use` for each replacement slot.
  - Body `{ dryRun?: boolean }`; answer `{ theme: { from: string | null; to: string;
    followsPlatform?: boolean } | null; replacements: { slot: string; from: string | null; to:
    string; followsPlatform?: boolean }[]; skipped: { what: string; reason: "unknown-slot" |
    "not-available" | "not-eligible" }[] }`. At the **org level `from` is the value in effect** (the
    org's own entry, else the platform's) and `followsPlatform: true` says it is the platform's
    (the web shows 跟随平台：<name>); an org that follows a platform already using the suggestion
    gets nothing pinned, and a followed platform theme that is no longer eligible reads as the
    built-in. Platform-level results carry no `followsPlatform`. Results come **in the author's
    order** (`suggestedAppearance` as written): prepare stages the key order
    (`catalog_item_versions.appearance_order`, migration 0107) because the staging jsonb drops it.
    Two refs to one slot (`shell.brand` and `shell.brand@1`) are refused by the SDK parser; a stored
    duplicate is skipped as `not-eligible`. The web first calls with
    `dryRun: true` and shows the changes in a confirm dialog; the confirmed call writes everything
    in one transaction (theme lock order of the themes spec §6: catalog item → theme row →
    `uiTheme` row, then the arrangement), or nothing when `theme` would be refused.
  - Refusals follow the existing rules: a platform theme that cannot be the platform default (not
    platform-owned `all`, off in a live org) is `theme.not_available` (400), as `PUT
    /api/v1/admin/settings` would answer (the org route answers the same 400 when the suggested
    theme is not on in the org); a replacement whose contribution is not available where
    it is set is skipped (`not-available`), not refused, because the arrangement keeps unknown keys
    anyway (§6.3).
  - Shown only when the plugin has a `suggestedAppearance` and the viewer may write the level; org
    members see nothing (roles everywhere).
  - **A plugin with client code reloads the page after a successful apply** (the document's client
    set is fixed at its first render, so the new brand would otherwise wait for a manual reload):
    the confirm dialog says so (此插件带有界面代码：应用后页面会重新加载…) and the document is
    reloaded once the write succeeds. A theme-only plugin does not reload.
- Platform operations `plugins.platform-apply-appearance` (`catalog-admin.ops.ts`) and
  `plugins.apply-appearance` (`org-plugins.ops.ts`) mirror the two routes (confirmed, never
  rememberable; `dryRun` is the preview, so it is not an input); `check:platform-ops` covers them.
- An org member calling the org route gets 403 (`org.update`); an extension not on in the org, or
  whose plugin suggests nothing, is `extension.not_found`; an unknown catalog item is
  `catalog.item_not_found`.
- **Availability is judged on the serving replica**: a replacement is available when this replica
  has the extension loaded with that `component` contribution and (for an org) enabled for the org
  (`host.enabledPlugins`, `host.uiContributions()`), so a replica that has not loaded the extension
  yet skips its replacements as `not-available`. A slot that is not single or not arrangeable at the
  level is `not-eligible`.
- Item details gain `suggestedAppearance` (admin `GET /api/v1/admin/catalog/items/:id`, the org
  extension list) so the pages know when to offer the action.

## 7. L3 decoration

### 7.1 Parts (decided by Claude under the 2026-11-09 grant, C5)

- The SDK exports `UI_PARTS`, a literal catalog: `{ name, version, owner, states, description:
  { en, zh } }[]`. `owner` is a **list** of the files (in `packages/design/src` or `apps/web/src`)
  that render the element (one concept is drawn by several components: `sidebar.item`, `section`,
  `card`, `input`, `dialog`; the generated guide prints the list); `states` lists the ARIA / data attributes the part promises (`aria-current`,
  `aria-selected`, `aria-expanded`, `aria-busy`, `disabled`).
- Built-in elements carry `data-cap-part="<name>"` (a literal attribute). This is the public
  contract; the existing `data-part` attributes stay internal (tests and design CSS) and may change
  freely.
- The first catalog (all version 1):

| Part | Element | Owner | States |
|---|---|---|---|
| `shell` | the App Shell root (also carries `data-cap-state`, §7.3) | design `shell/app-shell.tsx` | — |
| `sidebar` | the left sidebar | design `shell/sidebar.tsx` | — (the rail vs full mode is the `sidebar=` token of §7.3) |
| `sidebar.brand` | the brand row | design `shell/sidebar.tsx` | — |
| `sidebar.item` | a navigation or conversation row | design `shell/sidebar.tsx`, `shell/sidebar-conversations.tsx` | `aria-current` |
| `title-bar` | the conversation title bar | design `conversation/` (title bar) | — |
| `page-header` | a page's header | design `shell/page-header.tsx` | — |
| `thread` | the conversation stream | design `conversation/` (thread) | `aria-busy` |
| `message.user` | a person's message (the full-width row) | design `conversation/bubble.tsx` | — |
| `message.user.bubble` | the bubble of a person's message, inside the `message.user` row | design `conversation/bubble.tsx` | — |
| `message.assistant` | an assistant turn | web `conversation/Thread.tsx` | `aria-busy` while its text streams |
| `tool-row` | a tool call line | design `conversation/` | `aria-expanded` |
| `composer` | the composer box | design `conversation/composer.tsx` | `aria-busy` |
| `properties-panel` | the conversation properties panel | design `conversation/` | — |
| `section` | a `PropertySection` / `FormSection` | design `display/`, `templates/` | — |
| `right-panel` | a full-height right pane | design `conversation/` | — |
| `status-bar` | the status bar | design `shell/status-bar.tsx` | — |
| `button` | every `Button` | design `controls/button.tsx` | `disabled` |
| `button.primary` | a primary `Button` (adds to `button`: `data-cap-part="button button.primary"`) | design `controls/button.tsx` | `disabled` |
| `card` | `Card`, `InlineCard`, `ObjectCard` | design `layout/`, `display/` | — |
| `input` | text inputs, textareas, selects | design `controls/inputs.tsx` | `disabled` |
| `dialog` | `Dialog`, `Sheet` | design `overlays/` | — |
| `code-block` | a `CodeBlock` (Markdown code, setup guides, diffs) | design `display/chat.tsx` | — |
| `menu` | a `Menu`, submenu, `Popover`, the composer's menus | design `overlays/menus.tsx`, `conversation/menu.tsx` | — |
| `segmented` | a `Segmented` control (its segments are radios, `aria-checked`) | design `display/tabs.tsx` | — |
| `stat-card` | one card of `StatCards` | design `display/stat-cards.tsx` | — |
| `switch` | a `Switch` | design `controls/toggles.tsx` | `aria-checked`, `disabled` |
| `switch.knob` | the knob inside a `switch` | design `controls/toggles.tsx` | — (follow the switch's state) |
| `org-avatar` | the org's initial block in the org switcher | design `shell/sidebar.tsx` | — |
| `agent-chip` | an agent chip of the new conversation's agents row | design `conversation/agent-row.tsx` | `aria-pressed` |

  Added after the theme plugin round (2026-11-10): themes style only what carries a part, so
  these were added on their owning elements; no existing part was renamed.

  A part attribute may hold several names separated by spaces; plugin CSS selects with
  `[data-cap-part~="button.primary"]`. The builder fixes the exact owner file of each row while
  adding the attributes; `check:ui-parts` then pins it.
- **`check:ui-parts`** (new, full on PRs: cheap, reads the SDK catalog and scans
  `packages/design/src` and `apps/web/src`): every catalog part appears as a literal
  `data-cap-part` in its owner file; every literal names a catalog part; the generated copies
  (`packages/design/src/ui-parts.generated.ts`, `packages/plugin-client/src/ui-parts.generated.ts`)
  and `docs/guide/ui-parts.md` are current (`pnpm gen:ui-parts`). Rules `ui-part-unrendered`,
  `ui-part-undeclared`, `ui-part-owner`, `ui-part-literal`, `ui-parts-stale`; proven red first.
- **Versions**: renaming or removing a part, or dropping a promised state, bumps its `version` and
  needs a release note; after 0.1.0 the old name stays on the element for one minor release.
  Changing the element's inner markup is not a contract change (selectors should stop at the part).

### 7.2 The CSS layer

- Today the design stylesheet is unlayered (`packages/design/src/styles/index.css` has no
  `@layer`) and so is the theme stylesheet (`packages/kernel/src/themes/render-css.ts`), and an
  unlayered rule beats every layered one whatever the order. So the layer order is declared and
  everything goes into a layer (designer's call, the smallest change that makes C5's
  `@layer extensions` win):
  - `packages/design/src/styles/index.css` starts with `@layer design, theme, extensions;` and
    imports every file with `layer(design)`;
  - `renderThemeCss` wraps its output in `@layer theme { … }`;
  - plugin CSS is wrapped in `@layer extensions { … }` by the packer (§4.1); the kernel's import
    refuses a client CSS file that is not exactly one such block or that contains `@import` or an
    absolute `url()` (`client.invalid`, 400). Selectors are not policed (D3).
- Known leftover: Next's generated `_global-error.html` carries an unlayered `<style>` that beats the
  design layer on that one page; harmless (it is the root error fallback and loads no client code).
- Injection: plugin stylesheets are `<link rel="stylesheet" precedence="extensions" integrity=…>`
  rendered by the workspace layout after the theme link (§9.5), so decoration is in the first
  paint. Plugins are injected in extension-name order, files in `styles` order.
- Plugins may read every `--cb-*` token and define custom properties named `--cx-<plugin>-*`.
  Overriding `--cb-*` tokens from plugin CSS works but is outside the promise (themes are the
  contract for tokens; their readability floors do not see plugin CSS).

### 7.3 State hooks

- The shell element (`[data-cap-part~="shell"]`) carries `data-cap-state`, a space-separated list
  of tokens:
  - `run=idle|running|waiting|failed`: the open conversation's run (§7.6); `idle` elsewhere;
  - `motion=full|reduced`: `prefers-reduced-motion`, added after hydration;
  - `theme=<plugin>/<theme file id>` or `theme=builtin`: the resolved theme (`ThemeRef.key` falls
    back to the file id when the theme has no plugin);
  - `sign-in=new`: present, from the server render on, for the whole first workspace document of a
    sign-in, so a plugin can greet once per sign-in (a boot screen) without the page showing first.
    The proxy compares the session of the request (the sha256 of the access token's `sid`, read
    without verifying) with the one in the `cap_seen` cookie, which it sets on that document; only
    workspace documents count (not the admin console, public pages, RSC fetches or prefetches). A UI
    hint, never an access check; a forged copy of the internal `x-cap-sign-in` header is dropped;
  - `sidebar=rail|full`: the sidebar's mode, added by the shell after hydration (the drawer below
    960 px counts as `full`: it is the full sidebar). The order is `run`, `theme`, `sign-in`,
    `motion`, `sidebar`.
- Plugin CSS selects with `[data-cap-state~="run=running"] [data-cap-part~="properties-panel"]`;
  a run-state colour change needs no JS.
- The server render writes `run=idle`, the theme token (`AppFrame` has the theme from
  `ThemeRoot`) and `sign-in=new` when it applies; the browser updates `run` and adds `motion`. CSS that matters at first paint
  should use `@media (prefers-reduced-motion: reduce)`, which the token mirrors.
- `ThemeRef` (themes spec §9) gains `key: string`, `"<plugin>/<theme file id>"`, for the token and
  `useTheme()`.
- Placement on the shell element, not `<html>` (a change to C5, §17): the root layout owns
  `<html>` and cannot see the workspace's data, and an attribute React renders in the shell
  hydrates without a mismatch.

### 7.4 The overlay

- `shell.overlay` (C5) is rendered by `AppFrame` inside a new design primitive `DecorationLayer`:
  `position: fixed; inset: 0`, a new layering token `decoration` above every other layer, and
  `pointer-events: none` on the layer and its descendants, except elements marked
  `data-cap-interactive` (a "skip" button of a boot animation).
- The layer itself is **not** `aria-hidden`: an interactive element under `aria-hidden` would be
  focusable yet invisible to assistive tech. A layout effect and a `MutationObserver` mark with
  `aria-hidden` every element that neither is nor holds an interactive element (`data-cap-interactive`
  or focusable; the layer tags its own marks, so a plugin's `aria-hidden` stays and only the layer's
  are removed again). Text sitting directly beside an interactive element cannot take `aria-hidden`,
  and moving a node React owns would break its reconciliation (tried and reverted), so **a plugin
  marks decorative text beside its interactive elements itself** (wrap it in an element with
  `aria-hidden="true"`). Overlay components must not hold content a person needs.
- Contributions render in arrangement order; at most 4 (`limits.maxShown`).
- The layer is not rendered in safe mode, under the kill switch, or on admin pages (§9.6).

### 7.5 Client events

Derived in the web from the conversation stream it already reads (`useConversation`); no new
kernel stream (C5). Each event is delivered once, in `seq` order, for events appended to the open
conversation while the page is open (including those caught up after a stream reconnect), never
for history loaded when the page opens: the first list the feed sees (the history read on open)
sets a baseline and emits nothing, and every later list emits the events past the highest seq seen.
So **a revisit's catch-up** (events that arrived while the page was away, read from the cache and
the stream) **emits those events as live ones**; history below the baseline (an earlier page of
history) never emits. Events are derived on the client from the log the page already reads
(`apps/web/src/components/client-ext/events.ts`).

```ts
type CapybaraEventType =
  | "run.started" | "run.finished" | "run.failed"
  | "message.sent" | "message.received"
  | "tool.started" | "tool.finished"
  | "approval.requested";

interface EventBase { conversationId: string; seq: number; at: string /* ISO time of the event */ }

type CapybaraEvent =
  | ({ type: "run.started" } & EventBase)
  | ({ type: "run.finished"; reason: string } & EventBase)  // run_finished.reason, or "aborted"
  | ({ type: "run.failed"; code: string } & EventBase)       // run_failed.error.code
  | ({ type: "message.sent" } & EventBase)                   // a person's user_message
  | ({ type: "message.received" } & EventBase)               // assistant_message
  | ({ type: "tool.started"; callId: string; tool: string } & EventBase)
  | ({ type: "tool.finished"; callId: string; tool: string; isError: boolean } & EventBase)
  | ({ type: "approval.requested"; callId: string } & EventBase);

type CapybaraEventOf<K extends CapybaraEventType> = Extract<CapybaraEvent, { type: K }>;
```

| Client event | From the log event |
|---|---|
| `run.started` | `run_started` |
| `run.finished` | `run_finished` (`reason`), `run_aborted` (`reason: "aborted"`) |
| `run.failed` | `run_failed` (`error.code`) |
| `message.sent` | `user_message` without `dispatch` (a person's, not a parent agent's) |
| `message.received` | `assistant_message` |
| `tool.started` | `tool_call_started` (call id, tool key) |
| `tool.finished` | `tool_result` (call id, the tool key of its call, `isError`) |
| `approval.requested` | `approval_requested` |

- Payloads carry no message text, tool input or output (designer's call: the events are signals;
  a component that needs content has `useView`, or reads the page, full trust). Adding a field is
  compatible; removing or renaming one needs `CLIENT_API_VERSION` 2.
- Delivery is asynchronous (a microtask after the stream update commits); a listener that throws
  counts toward its plugin's crash budget (§10.3) and does not stop other listeners.
- Sub-agent conversations shown in the side panel do not emit events (only the page's
  conversation).

### 7.6 Run state

- `useRunState()` and the `run=` token come from the conversation page: `ConversationView`
  publishes its phase (`useConversation`: `waiting` / `running` / `idle`) into a run-state context
  above `AppFrame`; `failed` is set by `run_failed` and holds until the next `run_started` or
  navigation. Pages without a conversation publish `idle`.

## 8. Sound and motion

- No sound API: sound is an `events` listener or a component using the Web Audio API, from assets
  of the plugin (`assetUrl`) or synthesized.
- Rules for plugins (documented, not enforceable): sound is off by default and turned on by the
  person (stored with `useClientStorage`), and `usePrefersReducedMotion()` / `motion=reduced`
  disable animation. The acceptance (§15) checks both.

## 9. Delivery

### 9.1 Storage

- **Build id**: the client files of a package are identified by the package's sha256
  (`extension_packages.sha256`), the same id `extension_installs.sha256` names for the running version
  (a change to C6's `<version>-<catalogVersion>`, §17).
- When a package with a `client` section is stored (the `extension_packages` insert in `ExtensionBlobs.record`, `extensions/blobs.ts`, of an import or
  upload, idempotent by sha256), the kernel reads the client files from the tgz, checks the
  section (limits, types, CSS wrap, every `integrity` value recomputed from the bytes: mismatch is
  `client.integrity_mismatch`, 400), and writes them to object storage under
  `deployment/platform/client/<plugin>/<sha256>/<path inside dist/client/>` (the storage service
  adds the `deployment/` prefix).
- Migration `0107_extension_client_builds.sql` (0104 to 0106 were taken on `main`), kernel schema:
  `extension_client_builds (package_sha256 text PRIMARY KEY REFERENCES extension_packages(sha256) ON
  DELETE CASCADE, plugin text NOT NULL, entry text, styles text[] NOT NULL, assets text[] NOT NULL,
  integrity jsonb NOT NULL, sizes jsonb NOT NULL, api_version int NOT NULL, object_prefix text NOT
  NULL, created_at timestamptz NOT NULL DEFAULT now())`. The integrity values come from this row,
  never from the object store.
- The same migration adds `extension_replica_status.serving_sha256`, the package a replica actually
  serves for the plugin (§9.3).
- A package with client code imported while no object store is available is refused with
  `storage.unavailable` (the existing code), so the stored row always has its files.

### 9.2 Routes

| Route | Guard | Purpose |
|---|---|---|
| `GET /api/v1/client/:plugin/:build/*file` | signed in; see access | the bundle, CSS and assets |
| `GET /api/v1/orgs/:orgId/ui/client` | `@OrgAction("ui.use")` (guest) | the org's client extensions for the shell read |
| `GET /api/v1/admin/ui/client?plugin=` | `@SuperAdmin`, human only | the platform set for admin pages; `?plugin=` narrows it to one plugin (the page `/admin/p/<plugin>/<id>` reads its own) |
| `POST /api/v1/orgs/:orgId/ui/client/reports` | `ui.use`, throttled | crash and load reports (§10.4) |
| `POST /api/v1/admin/ui/client/reports` | `@SuperAdmin` | the same from admin pages |
| `PUT /api/v1/admin/settings` | existing | gains `clientExtensions` (§10.2) |

The shell read answers:

```ts
interface ClientExtensionsResponse {
  enabled: boolean;     // false under the kill switch: items is empty
  apiVersion: number;   // the host's CLIENT_API_VERSION, echoed for diagnostics
  items: {
    plugin: string;
    build: string;      // package sha256
    entry: { url: string; integrity: string } | null;
    styles: { url: string; integrity: string }[]; // empty in the admin set (§9.6)
    components: { id: string; slot: ComponentSlotId }[];
    signInId: string;   // the viewer's sign-in id for this plugin (ClientApi.signIn.id)
  }[];
}
```

- **Which items** (D2): the org route lists every extension enabled in the org (`enabled.ts`,
  scope and switch) whose deployment status is `running` (approved, derived from PG, not a
  replica's memory) and whose current package has a client build; `components` is filtered by
  each slot's `minRole` for the viewer. The admin route lists running extensions with at least one
  `component` in `platform.page`, and only those components.
- URLs are `/api/v1/client/<plugin>/<build>/<path>` (`path` relative to `dist/client/`, e.g.
  `client.mjs`, `styles/hud.css`, `assets/boot.ogg`), so relative `url(../assets/…)` in CSS
  resolves.

### 9.3 Access and caching

- **Access** (C6): the delivery route serves a file when the build is **served** (below) and the
  caller is either a super admin (any build with a `platform.page`
  component) or a member, any role, of a live org where that extension is enabled. One PG query
  per request, not cached (as `verifyEmbedToken`). Otherwise 404 `client.not_found` (also for an
  unknown file, an old build no longer current, and under the kill switch).
- **The served build is the one a live replica runs** (`ClientAccess.served`): the package named by
  a fresh `extension_replica_status.serving_sha256` (heartbeat within `STALE_RECONCILE_PERIODS`
  reconcile intervals) for an enabled install, whose approved permission snapshot covers
  `permissions.client` and every `ui.component:<id>` of the manifest. The shell reads list, per
  extension, the install's current package when a replica serves it, else the newest build a replica
  still serves. So an upgrade pending approval, or one whose migration / setup / import failed,
  **keeps the old build served and listed**; the new build appears once a replica serves it; with no
  live replica nothing is served (fails closed). An org upload awaiting the super admin has no
  install, so nothing of it is served. Replaces the draft's "current package of a running
  extension" (§17).
- **The route never redirects** (no trailing-slash or case redirect): the document CSP allows
  scripts from this path prefix only (§9.5), and a redirect would leave it. The file is named from
  the **raw** request path, never the decoded wildcard: each segment must already be
  `[A-Za-z0-9._-]` and not `.` / `..`, so `%2F`, `%5C`, `%2e`, a backslash, `//` or a trailing `/`
  name nothing (404). "Never redirects" is about the **kernel** route. The web origin still sits in
  front of it (the web proxies `/api/v1/client/` to the kernel) and **Next answers its own 308**
  for a trailing or duplicated slash there; that is accepted (the redirect target is the same path
  prefix on the same host, which the CSP names, and no file name is valid with such a slash anyway).
- **An unsupported `api_version` is not delivered**: `ClientAccess.fetchable` applies the same
  `supported()` check as the shell reads, so a build the running kernel cannot support is a 404
  `client.not_found` for its files too (an older draft served them, with only the reads omitting
  the build).
- Client code is not a secret from the people it is served to: it runs in their browser.
- Headers: `Cache-Control: private, max-age=31536000, immutable`; `X-Content-Type-Options:
  nosniff`; `Cross-Origin-Resource-Policy: same-origin`; content types `text/javascript` (`.mjs`),
  `text/css; charset=utf-8`, and per asset type; SVG assets also get `Content-Security-Policy: default-src 'none';
  sandbox`. The shell routes are `no-store`.
- An old build's URL stops working once the extension upgrades (unlike theme versions, which stay
  public): a page still holding it keeps its loaded module; a later fetch 404s and is treated as a
  load failure (built-in), and the next document load gets the new build.

### 9.4 Import map and loading

- The host provides the externals through one import map rendered by the workspace layout:

```json
{
  "imports": {
    "react": "/_capybara/client-host/<webBuild>/react.mjs",
    "react/jsx-runtime": "/_capybara/client-host/<webBuild>/react-jsx-runtime.mjs",
    "react-dom": "/_capybara/client-host/<webBuild>/react-dom.mjs",
    "@capybara-hq/plugin-client": "/_capybara/client-host/<webBuild>/plugin-client.mjs"
  },
  "integrity": { "<entry url>": "sha384-…" }
}
```

- The `client-host` modules are static files generated into `apps/web/public/_capybara/client-host/`
  at build (`pnpm gen:client-host`; `<webBuild>` = the web package version plus a hash of the shim files, because the Next build id is unknown before the build; the e2e and visual harnesses run the generator, and the server logs a warning when the manifest is missing).
  Each re-exports, by name, from `globalThis.__CAPYBARA_CLIENT_HOST__` (React's export names
  enumerated at generation time) and throws `capybara client host not ready` when the global is
  absent. React stays the one instance inside the Next chunks; the shims only point at it.
- **Loading** (a change to C6's `<script type="module">`, §17): the layout emits, per entry, a
  classic `preload` (React DOM `preload(url, { as: "script", crossOrigin: "anonymous", integrity })`),
  so the bytes are fetched and verified in parallel with the page. React delivers the call as a
  **Flight hint** that the client turns into a `<link rel="preload">`, so the link is not in the
  first server HTML bytes (Task 21 ruling; cost: a slightly later preload, never a failure). It is not `modulepreload`: React
  hoists every preload into `<head>` before the import map, and a module preload that finishes
  before the map is parsed caches the module with its bare imports unresolved (Chromium); the
  classic preload only warms the fetch and `ClientHost`'s `import()` reuses it. `ClientHost`, a client component in the
  workspace layout, sets `__CAPYBARA_CLIENT_HOST__` (React, React DOM, the JSX runtime, the
  plugin-client implementation, the design subset, `CLIENT_API_VERSION`) in its first layout
  effect, then `import()`s each entry in extension-name order, in parallel. A module script tag in
  the server HTML would evaluate before Next's async chunks have provided React to the global.
- Integrity: the import map's `integrity` section and the preload's `integrity` both carry the
  value from `extension_client_builds`, and the section also pins every shim (sha384 in the
  generated manifest), so every module of the graph is verified; a mismatch makes the import fail
  (load failure, §10.3).
  Stylesheets carry `integrity` on their `<link>`.
- Each entry's default export must be a `ClientExtension` whose `name` equals the plugin and whose
  `apiVersion` the host supports; each component's `slot` must equal the manifest contribution's
  slot. Anything else: that extension (or that component) is not activated and is reported.
- Load timeout `CLIENT_LIMITS.loadTimeoutMs` = 10 000 per entry.

### 9.5 CSP

- Today the web sends no document CSP (only the `/plugin-ui` proxy and the object-store proxy set
  one). The App Router injects inline scripts (the flight data), which a policy of `'self'` plus
  an import-map hash would block. So (a change to C6, §17) `apps/web/src/proxy.ts` generates a
  per-request nonce and sets on every document response `script-src <host>/_next/
  <host>/api/v1/client/ <host>/_capybara/client-host/ 'nonce-<n>'; object-src 'none'; base-uri
  'none'; frame-ancestors 'self'; form-action 'self'` (dev adds `'unsafe-eval'` for React's dev
  build; production never allows eval or `'unsafe-inline'`). Not `'self'`: the sources are path
  prefixes on the document's host, with no scheme (so they follow the page's and stay right behind
  a TLS proxy), which is why the delivery route never redirects (§9.3). The host is the first
  `X-Forwarded-Host` value when present and nameable by a CSP host source, else `Host`; a host a
  source cannot name (an IPv6 literal) gets no path sources, only the nonce. A reverse proxy must
  forward the original `Host` (docs/deploy/README.md). Next applies the nonce to its own scripts
  (it takes it from the forwarded request's CSP and `x-nonce`); the import map carries it. A
  client-sent nonce or policy never survives. The proxy skips `/api/*`, `/plugin-ui/*`, `/_next/*`,
  `/dev/ui/*` and `/icon.svg`; the client-host shim files get the CSP only. No remote script origin
  is ever allowed.
- `style-src`, `connect-src`, `img-src` stay unrestricted (full trust, D2; the design system uses
  inline styles); revisiting them is a follow-up.

### 9.6 Where client code runs

- **Workspace pages** (`(app)` layout, an org selected, not `/admin`): the org set. Components in
  every component slot, plugin CSS, the overlay.
- **Admin pages** (`/admin/*`) **(decided by Claude under the 2026-11-09 grant)**: no org client
  code, no plugin CSS, no overlay, no replacements; only the L0 theme applies (as today). The one
  exception is platform-scope client code: `platform.page` components, loaded only on their own
  page `/admin/p/<plugin>/<id>` (the admin set of §9.2 is read by that page alone). The admin
  console stays the official UI, so a broken decoration can never stop the super admin from
  switching it off. It therefore has the platform look by design: the L0 theme's tokens and logo,
  never a plugin's brand styling (a stylized wordmark, HUD parts) or its overlay, even while the
  workspace beside it wears them (browser review F07, 2026-11-10: decided, no change).
- **Crossing the boundary**: modules cannot be unloaded, so the loaded set is fixed for a
  document. A client navigation to a page whose client set differs (workspace ↔ admin, into or out
  of a `/admin/p/<plugin>/<id>` page with client code, or to another org), while a client extension
  is loaded on either side, becomes a document navigation (`ClientHost` turns the router transition
  into `location.assign`). The admin console thus never runs org client code in the same document.
- **The set changes while a page is open** (the shell read is invalidated by an extension switch,
  an upgrade, the kill switch): an extension no longer listed stops rendering at once (its
  components unmount to the built-in, its stylesheets are disabled like superseded theme sheets,
  its listeners stop receiving events); a new or upgraded build loads at the next document load.

## 10. Safety

### 10.1 Safe mode

- `?safe-ui=1` on any workspace or admin URL (C7): the layout renders no import map, no preload,
  no plugin stylesheet, no overlay; replaceable slots render the built-in; component contributions
  in list slots are skipped (L1 views and embeds still render). The proxy forwards the query (the
  path header carries it), so the server render already omits everything.
- **Safe mode lasts the browser session** (a change to C7, §17): the proxy sets the session cookie
  `cap_safe_ui=1` (`Path=/`, `HttpOnly`, no max-age) on any document requested with `?safe-ui=1`, and every
  later document render, reload and client navigation stays in safe mode until `?safe-ui=0` (the
  proxy clears the cookie) or the banner's exit, which navigates to the same URL with
  `safe-ui=0`. The request that ends it still carries the cookie, so `safe-ui=0` wins over it.
  `ClientHost` pins the mode at its first render, so a later layout render cannot change it for the
  document. Because the cookie is `HttpOnly`, script cannot clear it: the exit is always a
  navigation through the proxy to `?safe-ui=0`.
- **Safe mode is a shell state**: the banner (安全模式：未加载插件界面代码 · 退出) shows while it is on
  and client code exists for the viewer, and it is a **row of the App Shell** (the design `AppShell`
  and `SetupPage` take `banner`; `ClientHost` supplies it through a context, the shell becomes a
  grid with the banner in row 1 and sets `data-banner="true"`), never an element above the
  100dvh shell, so it cannot push the status bar or the composer out of the viewport.
- The root error page, the `(app)` error boundary and the crash-budget notice (§10.3) carry a link
  以安全模式重新加载 to the current URL with `safe-ui=1`.

### 10.2 Kill switch

- Deployment setting `clientExtensions: { enabled: boolean; disabled: string[] }`
  (`DEPLOYMENT_SETTINGS`, default `{ enabled: true, disabled: [] }`; written by `PUT
  /api/v1/admin/settings`, Platform operation `admin.update-settings`, confirmed and never
  rememberable). `enabled: false` stops all client code (C7); `disabled` lists plugins whose client
  code alone is stopped while their server side keeps running (designer's call: a broken bundle
  should not cost the plugin's tools).
- A stored value that fails to parse logs a warning and reads as the default (`parseClientExtensions`).
- Effect: the shell routes return `enabled: false` / omit the plugin, delivery returns 404
  `client.not_found`; **open pages drop the extensions at their next client-set read** (30 s
  freshness, a reconnect, a navigation or a reload; the admin write invalidates the admin's own
  cache like the platform theme, not other people's tabs). Plugin JavaScript that already ran cannot
  be unloaded anyway: its components unmount and its sheets are disabled, but a tab keeps what the
  plugin did outside React until its next document load (Task 21 ruling; cost: an open tab keeps a
  plugin until its next read).
- 平台设置 gets a section 插件界面代码 with the switch and the per-plugin list; the admin extension
  detail has a 停用界面代码 action writing `disabled`.

### 10.3 Error boundaries and the crash budget

- Every component renders inside its own error boundary (list slots: the existing
  `BlockBoundary` line 加载失败 · 重试; replaceable slots: the built-in; the overlay: nothing).
- A **crash counts once per contribution per document** (`plugin, build, contribution, kind`, like
  the reporter): the rail and the open drawer drawing the same brand twice, or a retry loop, spend
  one unit. Errors of no contribution (listeners, uncaught errors, load failures) count each time.
- A plugin's **errors** are: a boundary catch in one of its components, a throw in an `events`
  listener, a failed or timed-out load, an unsupported `apiVersion`, and an uncaught `error` /
  `unhandledrejection` whose `filename` or stack names its build URL.
- **Crash budget** (C7): at `CLIENT_LIMITS.crashBudget` = 3 errors in one document, the plugin is
  disabled for the browser session (`sessionStorage` key `cap-client-disabled`, a list of
  `<plugin>/<build>`): its components unmount to the built-in, its stylesheets are disabled, its
  listeners are dropped. A notice says 「<插件>」的界面代码出错，已在本次会话停用 with the safe-mode
  link. A new build of the plugin is not covered by the old entry.
- **A client navigation that is not a click** (a router push, back / forward) crossing the boundary
  of §9.6 leaves plugin code first: in the same layout effect, before `navigate`, the host disables
  every extension sheet and marks every plugin disabled, so no plugin style outlives the move.
- **Component pages and sections have designed states** (`ClientComponentBody`): ready draws the
  component; loading a skeleton; failed (delivered but the entry failed or lacks the component) a
  load-failed line with retry (a document reload); off (not delivered: safe mode, the kill switch,
  a plugin outside the document's set, or disabled by the crash budget or a withdrawal) an empty
  state 此插件界面当前不可用。 with a hint. `org.page` and `platform.page` use it at page size;
  `agent.detail.section` always draws its section frame with the body inside. **Navigation hides
  what cannot render**: the sidebar's extension pages, the agent sections and the admin console's
  platform pages are filtered through the same availability (the admin console has no client set:
  it reads safe mode from the host, the kill switch and its per-plugin list from the deployment
  settings, and the session budget when known), and `conversation.panel` is not offered in safe
  mode or under the kill switch; the host always draws the panel's own frame (title, close).
- **Stylesheets** are policed by `ClientHost`: React never removes a hoisted `<link>`, so every
  extension sheet (`data-precedence="extensions"`) that does not belong to an active plugin of the
  document's set (all of them in safe mode) is disabled (`link.disabled`), now and on every head
  mutation. Consequences, both accepted: a plugin disabled for the session (the budget entry in
  `sessionStorage`) **flashes its CSS until hydration**, because the server cannot see session
  storage; and styles a component **injected from JavaScript** (its own `<style>` element) persist
  after the plugin is withdrawn from an open page (switch, upgrade, kill switch) **until the next
  document load**: plugins remove what they add on unmount.

### 10.4 Reports

- The web reports once per document per `(plugin, build, contribution, kind)`. The server bounds
  what a member may store: `contribution` is null or must be one of **the build's own component
  ids** (grammar `^[a-z][a-z0-9-]{0,39}$`; anything else is 400, an id the build lacks is 404
  `client.not_found`), so reports cannot grow without bound:
  `POST …/ui/client/reports` with `{ plugin, build, contribution: string | null, kind: "load" |
  "render" | "event" | "api" | "budget", message: string }` (`message` ≤ 500 characters, the
  error's message only, no stack or page data; a longer one is 400, not truncated; 204 on success,
  404 `client.not_found` for an extension not on in the org or a build the caller cannot fetch). Throttle: 20 per minute per account (a named
  throttler).
- Stored in `extension_client_reports` (same migration): one row per `(plugin, build, org_id,
  contribution, kind)` (`org_id` null for admin pages) with `count`, `first_at`, `last_at`,
  `last_message`; upsert, no process state. `org_id` is not a foreign key: **a report's org may name
  an org that was deleted since**, which the admin page shows as 已删除的组织 (Deleted organization),
  admin pages as 管理后台页面. Rows older than 30 days are deleted by a
  `@LockedCron` job under `WorkerModule` (`client-reports-prune`, daily).
- The admin extension detail (`GET /api/v1/admin/extensions/:name`) gains `client: { build,
  files, sizes, apiVersion } | null` and `clientReports` (the current build's rows, newest first,
  at most 50 **per extension, limited in SQL**; the build is the one a live replica serves, §9.3);
  the page shows them under 界面代码 with the org names (`adminOrgsQuery`) and, in the catalog item
  detail and the org extension view, the client files with their sizes.

## 11. Web integration

- **Server render** (`app/(app)/layout.tsx`): `getShell` adds, in its parallel wave,
  `clientExtensionsQuery(orgId)` on workspace pages (on `/admin/p/<plugin>/<id>` the admin set,
  limited to that plugin; on other admin pages nothing), as a `section` (a failed read
  loads no client code; the page works). The layout renders, unless safe mode: the import map
  (with the nonce) at the top of the body, a `preload` per entry (§9.4), the plugin stylesheets with
  `precedence="extensions"` (after `ThemeRoot`'s `precedence="theme"` link, so React orders them
  after it), and `ClientHost` around `AppFrame`.
- **Hydration**: no plugin code runs on the server. Component contributions in list slots render
  nothing on the server and on the first client render, then appear when their module is
  registered; replaceable slots render the built-in (hidden while pending, §6.4). Nothing differs
  between the server HTML and the first client render, so hydration never mismatches. (A winner the
  shell lists and the document's set delivers is drawn pending on the server, §6.4.)
- **The set changes while a page is open** (§9.6): `ClientHost` compares the live set with the
  document's. Client code (an entry or a stylesheet) of a `plugin/build` the document lacks shows
  one notice per distinct addition, 新的插件界面代码已就绪，重新加载页面后生效。 with a 重新加载
  action; never in safe mode; a withdrawal or a plugin without code shows nothing.
- **`ClientHost`** (`apps/web/src/components/client-ext/`): sets the host global, imports the
  entries, keeps the registry (`plugin → { definition, status }`) in React state, delivers client
  events, applies the crash budget, sends reports, mirrors `motion` into `data-cap-state`, and
  enforces the navigation boundary (§9.6). It holds no state beyond the document.
- **`ExtensionSlot`** (UI slots spec §7) gains:
  - in list slots, `kind: "component"` contributions render `ClientComponentBlock` in the same
    places and order as views and embeds (`select`, `anchor` unchanged), inside the existing
    `BlockBoundary`, wrapped in the host context (plugin, contribution, slot args) the hooks read;
    a component whose module has not loaded renders nothing, then appears;
  - single slots take the built-in as a prop: `<ExtensionSlot slot="shell.brand" args={…}
    host={{ builtin: <Logo …/>, collapsed, panel }} />` (called once per drawn sidebar panel);
    `conversation.composer.frame` takes `builtin` and `children`; `ExtensionSlot` renders the
    winner (or the built-in, §6.3-§6.4);
  - `SlotArgs` / `SlotHost` gain the four new slots.
- `web-ui-extension-slot` (`check:web-ui`) adds `ClientComponentBlock` and `ReplaceableFrame` use
  to the renderers allowed only inside `components/extension-ui/`.
- `check:ui-slots` covers the new slots unchanged (one literal `ExtensionSlot` in the owner file).
- **No styles in apps/web**: the overlay layer, the pending frame and the safe-mode banner are
  design components (`DecorationLayer`, `ReplaceableFrame`, `SafeModeBanner`), plugin CSS is served
  by the kernel; `check:web-ui` rules are unchanged.
- **Data**: the shell read is a `defineQuery` (`keys.org(orgId).clientExtensions()`, freshness
  `org`; admin `keys.deployment().clientExtensions()`), invalidated by extension enable / disable /
  upgrade mutations and the kill switch (`useAppMutation`).
- **i18n**: every new string in zh and en.

## 12. Multi-replica

- No process state (C8): builds and integrity in PG, files in object storage, the shell read and
  the delivery check per request from PG, reports by upsert, the kill switch in
  `deployment_settings`. Every replica serves identical bytes and answers.
- The only periodic job is `client-reports-prune`, `@LockedCron`, under `WorkerModule`; no queue.
- Writes run in `@Transactional()` methods; the object-store writes of a client build happen
  before the `extension_client_builds` insert commits (a row never names missing files), and a
  failed insert leaves orphan files that the package's own cleanup removes with its prefix
  (`deletePrefix` after commit when the package row goes).
- The crash budget and safe mode are per browser (session storage, URL); nothing to share.

## 13. What does not change

- Not model-visible: no log event, no `DriftReason`; replays are unaffected. Client events are read
  from the log, never written to it.
- Views, embeds, `UiView` blocks and `UI_LIMITS` (except the new `componentDataBytes`), embed
  tokens (never valid for `/api`), the `/plugin-ui` proxy and its sandbox, the message bridge.
- Themes: resolution and readability floors (they do not see plugin CSS); the stylesheet moves into
  `@layer theme` and `ThemeRef` gains `key`. Delivery changes in one place: because the rendered
  bytes changed, the stylesheet URL carries a render revision,
  `/api/v1/themes/<id>/<version>/r<THEME_CSS_REVISION>/theme.css`, and only the current revision is
  served (an older URL promised another format).
- Extensions stay in-process and full trust; server-side permission semantics are unchanged; the
  new keys follow the existing approval flow.
- The auth layout, the org chooser and the root error and not-found pages load no client code.

## 14. Tests

- **SDK**: catalog shape with single slots (`single` ⇒ `replaceable`, `builtin`, `accepts` only
  `component`, no anchors); the new slots; `UI_PARTS` shape (names unique, owners under the two
  roots); structural validation of components (permissions both ways, one list per id, no `path`,
  slot accepting `component`, `client: true`); `PluginClientSection` parsing (limits, types,
  integrity format, entry or styles present).
- **plugin-client**: `defineComponent` / `defineClientExtension` shapes; hooks throw outside the
  host; the fake host in `/testing` drives `useView`, `useAction`, `useRunState`,
  `useCapybaraEvents`.
- **plugin-tools**: pack builds a client entry and styles, wraps CSS in the layer, writes
  integrity; red fixtures for `client-import-forbidden`, `client-css-remote`, `client-size`,
  `client-api-version`, `client-undeclared`, and the `client-css-selector` / `ui-part-unknown`
  warnings.
- **Kernel**: the permission keys are sensitive and block loading (a new component blocks an
  upgrade; a bundle-only change does not); import refusals (`client.undeclared`,
  `client.integrity_mismatch`, `client.invalid`); the client build stored once per sha256; delivery
  access (a member of an org where the plugin is on: 200; a member of another org, an org where it
  is off, a not yet confirmed org upload, an unapproved snapshot, the kill switch, a plugin in
  `disabled`, an old build: 404; a super admin: platform builds only); headers; the shell routes'
  filtering by role; `use` resolution (org over platform, unavailable = built-in, `use` refused on
  list slots); suggested appearance (dry run lists the changes and writes nothing; the confirmed
  call writes theme and picks in one transaction; a platform theme that cannot be the default
  refuses the whole call with `theme.not_available`; an unavailable replacement is skipped; an org
  member gets 404 / no action; manifest validation red cases for `appearance-invalid`);
  component views with `data` (limit, refused for views); reports upsert and
  throttle; the prune job runs once per tick on two replicas (dual-replica harness).
- **Checks**: `check:ui-parts`, `check:plugin-client-api`, the extended `check:ui-slots` and
  `web-ui-extension-slot`, `check:bootstrap` (client code refused): red fixtures first.
- **Testing package**: a `fake-client` fixture extension (a component in
  `conversation.properties.section` showing `useRunState` and `data` from its view, a `shell.brand`
  replacement, an overlay component, a CSS file on parts and `run=` states, an `events` listener
  recording into `useClientStorage`), and a `fake-client-broken` one (throws on render and in a
  listener). `packFixture` builds client entries.
- **Web** (unit): `ExtensionSlot` renders components, single slots fall back on throw and on
  timeout, the composer `children` check, the crash budget at 3, the event mapping table of §7.5
  (history not emitted, reconnect catch-up emitted once).
- **Web** (e2e, `apps/web/e2e/client-extensions.spec.ts`): with `fake-client` enabled, the first
  document has the CSP with a nonce, the import map and the stylesheet; the part CSS applies at
  `DOMContentLoaded`; the component appears; a run turns `data-cap-state` to `run=running` and
  back; the org admin picks the brand replacement and it shows; `?safe-ui=1` shows the official UI;
  the kill switch removes everything after the shell read; `fake-client-broken` is disabled after 3
  errors and the conversation still works; navigating to `/admin` is a document load and no plugin
  CSS is present there.
- The visual suite gains no plugin pages (plugins are not part of the design reference).

## 15. The theme-cyberpunk acceptance

D4 **(decided, 2026-11-09)**: in the dev environment, enabling `theme-cyberpunk` shows a "cyberpunk
capybara" UI. The plugin lives in `capybara-hq/plugins` (core tests load only `model-fake` and the
fixtures). Steps: install `theme-cyberpunk`, then click 应用此插件的外观 (§6.5: its
`suggestedAppearance` names its theme and the `shell.brand` and `conversation.empty`
replacements); nothing else. Its CSS and overlay scope themselves to
`[data-cap-state~="theme=theme-cyberpunk/<id>"]` / `useTheme()`, so a person who picks another
theme gets no decoration.

| D4 item | Contract used |
|---|---|
| Palette, fonts, logo | L0 theme `themes/<id>.json` (merged) |
| Run-state HUD panel in the conversation properties panel | L1 `view` in `conversation.properties.section` (or a `component` with `useRunState` and `useView` data) |
| Scanlines | plugin CSS on `[data-cap-part~="shell"]::after`, or a `shell.overlay` component |
| Chamfered borders | plugin CSS (`clip-path`) on `card`, `button.primary`, `composer`, `section`, `dialog` parts |
| Boot animation | a `shell.overlay` component, once per sign-in (`useSignIn().id` compared with the id stored by `useClientStorage()`), skipped when `usePrefersReducedMotion()` |
| HUD colour change with the run state | plugin CSS on `[data-cap-state~="run=running"]` / `run=waiting` / `run=failed` |
| Optional sound, off by default, reduced motion honoured | an `events` listener on `run.started` / `run.finished` / `approval.requested` / `tool.finished`, gated by a toggle stored with `useClientStorage`; the toggle is a `Button` in the HUD component |
| At least one built-in block replaced | `shell.brand` (glitch wordmark around `builtin`) and `conversation.empty` (cyberpunk hero) |
| No DOM hacks | `capybara-plugin check` passes with no `client-css-selector` or `ui-part-unknown` warning |
| Safe mode / kill switch return the official UI | `?safe-ui=1`; 平台设置 › 插件界面代码 off, or the plugin in `disabled` |

## 16. Phases

All in one implementation plan (`docs/superpowers/plans/2026-11-09-client-extensions.md`), in
waves; it starts after `feat/ui-slots` merges.

1. **SDK and toolchain**: catalog fields and the four slots, `component` kind and permissions,
   `PluginClientSection`, `CLIENT_LIMITS`, `UI_PARTS`; the `@capybara-hq/plugin-client` package
   (types, runtime, `/testing`); pack and check rules; changesets for `plugin-sdk`, `plugin-client`,
   `plugin-tools`; `pnpm gen:sdk-api`.
2. **Kernel**: permission keys and review, import checks and build storage (migration 0107),
   delivery and shell routes, `use` in the arrangement, the suggested-appearance routes and
   Platform operations, `clientExtensions` setting, reports and
   prune, Platform exclusions (delivery and reports `transport`, shell reads `internal`) and the
   `admin.update-settings` field (`check:platform-ops`), error codes `client.not_found`,
   `client.undeclared`, `client.integrity_mismatch`, `client.invalid`.
3. **Design and web foundations** (reviewed alone: CSP and trust boundary): CSS layers in design
   and the theme stylesheet, the document CSP with nonces, `data-cap-part` attributes and
   `check:ui-parts`, `DecorationLayer`, `ReplaceableFrame`, `SafeModeBanner`, `Sidebar` `brand`.
4. **Web host**: `gen:client-host`, `ClientHost`, the import map and preloads, `ExtensionSlot`
   components and single slots, the new slots in their owners, state hooks, client events, safe
   mode, crash budget, reports, the navigation boundary, admin pages (kill switch, detail, 界面位置
   selects).
5. **Fixtures, e2e, docs and skills**: `fake-client`, `fake-client-broken`, the e2e suite;
   `docs/guide/ui-parts.md`, the client sections of `writing-extension-ui`, `writing-plugins`,
   `writing-web-ui`; `docs/design/spec.md` §3 (the brand slot) and §4 (the decoration layer).
6. **Outside core**: `theme-cyberpunk` in `capybara-hq/plugins` and the §15 acceptance.

Follow-ups (not in this plan): `page.override` (whole-page override, C9), plugin-provided web
routes, `style-src` / `connect-src` in the document CSP, the composer action row as a slot, more
parts as plugins ask for them.

## 17. Review decisions

Maintainer decisions D1-D4 (2026-11-09) are recorded in §1, §2, §5.4 and §15. Controller rulings
C1-C9 are recorded where they apply; the ones below were adjusted to the code, each the smallest
change (the first five at design time, the rest while implementing):

- **C5, CSS layer**: `@layer extensions` alone would lose to the unlayered design and theme
  stylesheets (`packages/design/src/styles/index.css` declares no layer; `render-css.ts` emits
  plain rules), so design and theme CSS move into `@layer design` / `@layer theme` (§7.2).
- **C5, state hooks**: `data-cap-state` sits on the shell element, not `<html>`: the root layout
  (`app/layout.tsx`) owns `<html>` from cookies and cannot see the workspace's run or theme
  state; the shell is rendered by React and hydrates without a mismatch (§7.3).
- **C6, build id**: the running extension is `extension_installs.sha256` (migration 0030, tables renamed in 0041), so files
  are keyed by package sha256 (`deployment/platform/client/<plugin>/<sha256>/`,
  `/api/v1/client/<plugin>/<sha256>/<file>`), not `<version>-<catalogVersion>` (§9.1).
- **C6, loading**: SSR `<script type="module">` tags would evaluate before Next's async chunks
  expose React to the shims; entries are preloaded with integrity (a classic `preload`, below) and
  `import()`ed by `ClientHost` after it sets the host global (§9.4).
- **C6, CSP**: the web sends no document CSP today and the App Router's inline flight scripts
  need a nonce; the policy is `script-src 'self' 'nonce-<n>'` per request, not `'self'` plus an
  import-map hash (§9.5).
- **C7, safe mode lasts the session**: a document-scoped `?safe-ui=1` left a person one reload from
  the broken UI, so the proxy keeps it in the `cap_safe_ui` cookie (session, `HttpOnly`) until
  `?safe-ui=0` or the banner's exit, which navigates through the proxy; the banner is a row of the
  App Shell, not an element above it (§10.1).
- **C6, access follows the running server code**: client code is served from the build a live
  replica runs (`serving_sha256`), not the install's latest package, so a pending or failed upgrade
  keeps the old build (§9.3); the delivery route never redirects and reads the raw path (§9.3).
- **C6, import map and shims**: `<webBuild>` = web version + shim hash; entries are preloaded with
  a classic `preload`, not `modulepreload` (§9.4); the CSP names path prefixes on the document's
  host (§9.5).
- **C3 (UI parts), `owner` is a list** and the `sidebar` / `section` parts drop `aria-expanded`
  (§7.1); the `sidebar=rail|full` state token is added (§7.3).
- **Client events**: history emits nothing, but a revisit's catch-up emits events from while the
  page was away as live ones (§7.5).
- **Kernel gate for the client API**: import refuses `apiVersion` above the SDK's
  (`client.api_unsupported`), and the shell reads **and the delivery route** omit unsupported builds;
  the kernel's gate is authoritative, the bundle's declared `apiVersion` is a check the web repeats
  because the host stamps its own version into the import map (§4.2, §9.3).
- **Client CSS**: only `../assets/<own asset>`, `data:` and `#` urls; URL-making functions and
  invisible characters refused; the kernel re-tokenizes (§4.1). The rule lives in `plugin-sdk`
  (`clientCssProblem` / `wrapClientCss`), not in the kernel: the pack toolchain must not import
  the kernel (its decorated Nest services break the e2e harness's transform), and one module keeps
  pack and import identical.
- **Platform operation ids** are `plugins.platform-apply-appearance` and
  `plugins.apply-appearance`; availability of a replacement is judged on the serving replica (§6.5).
- **Theme CSS URL** gains a render revision (`r<THEME_CSS_REVISION>`) because the stylesheet moved
  into `@layer theme` (§13).
- **Migration** is `0107_extension_client_builds.sql`; the admin read takes `?plugin=` (§9.1, §9.2).
- **C3, addition**: a plugin with only CSS has no `ui.component:*` key, so `permissions.client`
  (sensitive, blocking) makes every client section visible to the review (§5.4).

Rulings on the draft's two open questions (decided by Claude under the 2026-11-09 grant): a plugin
may suggest its appearance and an admin applies it in one confirmed step, nothing automatic (§6.5,
§15); the admin console runs no org client code, plugin CSS, overlay or replacements, only the L0
theme, with `platform.page` components on their own page as the one exception (§9.6).

Designer's calls open to review: `clientExtensions.disabled` per plugin (§10.2); event payloads without content (§7.5);
bootstrap plugins without client code (§4.1); the 1 500 ms hidden built-in while a replacement
loads (§6.4).

Adjustments made by the final fix wave (2026-11-10), each the smallest change:

- **Next 308 on the web origin, none from the kernel**: "the delivery route never redirects" is
  about the kernel route; the web origin in front of it keeps Next's own 308 for trailing or
  duplicated slashes on `/api/v1/client/` (§9.3).
- **Delivery refuses unsupported `api_version` builds** (the draft served their files and only the
  reads omitted them), so a build the kernel cannot support is nowhere reachable (§9.3).
- **Flight-hint preload** (Task 21 ruling): the entry preload reaches the browser as a React Flight
  hint turned into a `<link rel="preload">`, not as a tag in the first server HTML (§9.4).
- **The kill switch reaches open pages on the next client-set read** (Task 21 ruling), not
  instantly; already executed plugin JavaScript cannot be unloaded (§10.2).
- **Reload after applying a client plugin's appearance**, and the "client set changed" notice with
  a reload action when the live set gains client code the document lacks (§6.5, §11).
- **Safe mode is a shell state**: a row of the App Shell, a session cookie that is `HttpOnly`,
  left only through `?safe-ui=0` (§10.1).
- **Component pages have designed states** (loading, failed, off) and navigation hides entries
  that cannot render; `conversation.panel` is not offered in safe mode or under the kill switch and
  its frame is always the host's (§10.3).
- **Client CSS rule in `plugin-sdk`** (`clientCssProblem`, `wrapClientCss`) (§4.1).
- **Bootstrap plugins cannot carry client code**, in the kernel (`client.invalid`) and in
  `check:bootstrap` (`bootstrap-client-code`) (§4.1).
- **Report contribution is limited to the build's own component ids** (400 / 404), and the admin
  detail limits reports per extension in SQL (§10.4).
- **A report's `orgId` may name a deleted org**: it is not a foreign key; the admin page labels it
  (§10.4).
- **`apiVersion`: the kernel gate is authoritative**; the web's own comparison is a repeat, because
  the host stamps its version (§4.2).
- **Appearance results** come in the author's order (`appearance_order`), and at the org level
  `from` is the value in effect with `followsPlatform` (§6.5).
- **`Sidebar` brand is a function of the panel** it is drawn in (`full`, `rail`, `drawer`) (§5.3,
  §6.2).
- **The composer frame renders its children exactly once** inside the frame (none, two, or a portal
  all fall back to the built-in) (§5.3).
- **Decoration layer**: interactive elements are never under `aria-hidden`; decorative text beside
  an interactive element is marked by the plugin itself, because rewriting React-owned text nodes
  was tried and reverted (§7.4).
- **A crash counts once per contribution per document** (§10.3).
- **Pending replaceable slots**: the server render draws a pending frame when a winner is listed,
  and CSS alone reveals the built-in after 1 500 ms (§6.4).

Added after the fix wave (2026-11-10):

- **Sign-in id** (`ClientApi.signIn`, `useSignIn()`, §4.2): the boot animation plays once per
  sign-in, which neither `sessionStorage` (per tab, survives a sign-out) nor `localStorage`
  (forever) can express. Each shell-read item carries `signInId` (§9.2): HMAC-SHA256, with a key
  derived from the master keyring (`client-sign-in/v1`), of the session id (a personal token: its
  token id) and the plugin name, truncated to 128 bits, base64url. It is stable across token
  refreshes, tabs and the org and admin reads of one sign-in, new after the next, never a
  credential; derived per request from the principal, so no state and every replica answers the
  same. The plugin name is an input only so that the id is not the same string in every plugin:
  that is **not an isolation boundary**, because client code runs with full trust in the page (D2)
  and any plugin can read the whole shell read or the query cache, which lists every plugin's id.
  Riding on the shell read costs no request; the web host takes it from the document's set (a
  sign-in always starts a new document), and the id is never empty. A master key rotation changes
  every id once, which client code sees as one more sign-in (during a rolling restart old and new
  replicas answer different ids until all restarted, so possibly a few more). Additive:
  `CLIENT_API_VERSION` stays 1.
- **`sign-in=new` state token** (§7.3, dev acceptance 2026-11-10): the sign-in id lets a boot
  screen play once per sign-in, but only after the client code loaded, so the page showed first.
  The token is in the server render of the first workspace document of a sign-in, so first-paint
  plugin CSS can cover the page until its component takes over. The proxy decides it from the
  access token's `sid` against the `cap_seen` cookie (a sha256, never the session id); no kernel
  state, every web replica answers the same.

No open questions remain.
