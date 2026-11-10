---
"@capybara-hq/plugin-client": patch
---

`ClientComponent` without a type argument is now the union of the single-slot bindings, so a
`defineClientExtension({ components })` map of components bound to different slots type-checks
under `strict` without a wrapper. The `shell.brand` props gain `panel` (`"full" | "rail" |
"drawer"`), the sidebar panel the brand is drawn in.
