---
"@capybara-hq/kernel": minor
---

Client builds are stored per package: migration `0105_extension_client_builds.sql` adds
`extension_client_builds` and `extension_client_reports`. When a package with an `extension.client`
section is stored, its client files are read again from the stored bytes, checked against the
section (every key exact, listed = present, size limits, sha384 recomputed, each stylesheet one
`@layer extensions` block with no `@import` and every `url()` an asset of the plugin, `data:` or a
`#fragment`, no non-ASCII whitespace, zero-width character or U+FEFF, no `image-set()`,
`cross-fade()`, `element()`, `paint()`, `src()` or `image()`; key segments of `[A-Za-z0-9._-]` only) and written under
`deployment/platform/client/<plugin>/<sha256>/`; the build row's integrity is what was recomputed.
New error codes `client.undeclared`, `client.integrity_mismatch` and `client.invalid` (400); a
package with client code is refused with `storage.unavailable` without object storage. The import
review re-checks the client files, checks `suggestedAppearance.theme` against the scanned themes
(`appearanceIssues`) and lists the client files with their sizes (`extension.client`). An expired
org upload's package takes its client files with it. The CLI's `capybara plugins import` stores client
files in its own object store (`loadCliObjectStore`).
