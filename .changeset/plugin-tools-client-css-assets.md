---
"@capybara-hq/plugin-tools": patch
---

`client-css-remote` now lets a stylesheet's `url()` (and `image-set()` strings) name only a file of
`client/assets` (`../assets/<path>`), a `data:` URL or a `#fragment`; any other relative path is
refused too, as the kernel refuses it at import. Asset paths may use only letters, digits, `.`,
`_`, `-` and `/`.
