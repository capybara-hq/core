# @capybara-hq/plugin-client

The client SDK for writing plugin UI for [Capybara](https://github.com/capybara-hq/core), an
open-source enterprise agent platform. A plugin's client entry (`src/client.tsx`) imports from this
package: `defineClientExtension`, `defineComponent`, the hooks (`useView`, `useAction`, `useAccess`,
`useLocale`, `useRunState`, `useCapybaraEvents`, `usePrefersReducedMotion`, `useTheme`,
`useClientStorage`, `useAssetUrl`) and a versioned subset of the design components (`Button`,
`Badge`, `Icon`, `KeyValue`, `Kbd`, `Logo`, `Spinner`, `Stack`, `Text`, `Tooltip`,
`PropertySection`, `ViewBlocks`).

```bash
npm install @capybara-hq/plugin-client
```

In the browser the specifier `@capybara-hq/plugin-client` resolves to the host's own implementation
of this interface (through an import map); `react` is provided by the host too. The package's own
runtime serves tests and type checking: `@capybara-hq/plugin-client/testing` has
`renderWithFakeHost(element, { slot, args?, role?, locale?, runState?, view?, onAction?, events? })`,
which renders a component inside a fake host (jsdom needed).

`CLIENT_API_VERSION` (1) is bumped only when a name is removed or its props change; the host
accepts a bundle built against its own version.
