---
"@capybara-hq/plugin-tools": patch
---

`client-css-remote` now lets a stylesheet's `url()` name only a file of `client/assets`
(`../assets/<path>`), a `data:` URL or a `#fragment`; any other relative path is refused too, as
the kernel refuses it at import. A stylesheet may not contain non-ASCII whitespace, zero-width
characters or U+FEFF, nor use `image-set()`, `-webkit-image-set()`, `cross-fade()`, `element()`,
`paint()`, `src()` or `image()` (escapes decoded). Asset paths may use only letters, digits, `.`,
`_`, `-` and `/`.
