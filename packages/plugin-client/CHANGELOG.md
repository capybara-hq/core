# @capybara-hq/plugin-client

## 0.1.0-rc.5

### Patch Changes

- 188af9d: A confirmed plugin import stops reading the staging it consumed (the error card that flashed before
  the navigation landed); an extension component asks for its view after mount, not from its render;
  extension pages draw no single-tab bar; the client API forwards the design system's `Select`, so a
  client component offers a plugin's choices in the product's own dropdown rather than the browser's;
  switching a plugin back on takes back the connector an earlier switch-off kept for agents instead
  of creating a second one (which failed on the slug); a connector slug may equal an installed
  extension's name (their tool keys stay apart, `mcp__` against `plugin__`), so a template whose
  default slug is its plugin's name (slack, github) configures as it is; a default-off connector
  template an admin switched on in the org asks for its input at install, as the install is what
  creates its connector (before, the wizard hid the fields and the install refused).

## 0.1.0-rc.4

### Minor Changes

- 6a4ffff: New UI parts for theme plugins: `message.user.bubble`, `code-block`, `menu`, `segmented`,
  `stat-card`, `switch` (`aria-checked`) with `switch.knob`, `org-avatar` and `agent-chip`
  (`aria-pressed`); `message.assistant` promises `aria-busy` while its text streams, and the web sets
  it on the live reply. `UiPartState` gains `aria-checked` and `aria-pressed`.

## 0.1.0-rc.3

### Minor Changes

- a49c72e: Client code can do something once per sign-in: `useSignIn()` and `ClientApi.signIn` carry an
  opaque id that stays the same for one sign-in and changes on the next one (a different string per
  plugin, not a secret between plugins).
  The kernel's client shell reads return it per item (`signInId`, a keyed hash of the session, never
  the session id) and the web host hands it to plugins; the fake host takes `signInId`.

## 0.1.0-rc.2

### Patch Changes

- abab378: `ClientComponent` without a type argument is now the union of the single-slot bindings, so a
  `defineClientExtension({ components })` map of components bound to different slots type-checks
  under `strict` without a wrapper. The `shell.brand` props gain `panel` (`"full" | "rail" |
  "drawer"`), the sidebar panel the brand is drawn in.

## 0.1.0-rc.1

### Minor Changes

- e6bff6e: New package: the client SDK for plugin UI components (`defineClientExtension`, `defineComponent`,
  the hooks, the design re-exports and `@capybara-hq/plugin-client/testing`).
- e531e6d: The SDK exports `UI_PARTS`, the catalog of built-in elements (`data-cap-part`) plugin CSS may
  select; `capybara-plugin check` reports `ui-part-unknown` against it.

### Patch Changes

- a4df9fd: `ClientExtension.apiVersion` documents what it holds in a browser (the host's version, stamped by
  the host's `defineClientExtension`) and that the kernel's delivery gate is the real check.
