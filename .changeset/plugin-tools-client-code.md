---
"@capybara-hq/plugin-tools": minor
---

`capybara-plugin pack` builds a plugin's client code (`src/client.ts[x]`, `client/styles/*.css`,
`client/assets/**`) into `dist/client/` with a sha384 per file and writes `extension.client`;
`capybara-plugin check` gains `client-import-forbidden`, `client-css-remote`, `client-size`,
`client-api-version`, `client-undeclared`, `appearance-invalid` and the warnings
`client-css-selector` and `ui-part-unknown`.
