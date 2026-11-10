# @capybara-hq/plugin-client

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
