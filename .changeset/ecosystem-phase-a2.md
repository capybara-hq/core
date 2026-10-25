---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

Marketplace, archive and git downloads can go through an HTTP(S) egress proxy: set `net.httpsProxy`
(credentials in the URL are sent as Basic proxy auth and never logged) and `net.noProxy` for hosts
that go direct. Behind the proxy the kernel no longer resolves the target (the proxy does and owns
SSRF protection for DNS names); IP-literal private targets are still refused, and a proxy refusing
`CONNECT` is reported as `net.proxy_refused`.

The plugin SDK adds the bootstrap manifest (`parseBootstrapManifest`, `bootstrapFileName`, JSON
Schema `schemas/bootstrap.v1.schema.json`) for `packages/kernel/bootstrap.json`, the plugins a
deployment installs at init, each pinned to an exact version and sha512.

Bootstrap plugins replace the builtin extensions. The kernel runs the bootstrap step at start
(`KernelOptions.bootstrapDir`, optional `bootstrapManifest`; once per manifest across replicas, under
an advisory lock) before loading extensions: every package is checked against its pinned sha512
(`bootstrap.integrity_mismatch`, `bootstrap.missing_file`), imported into the catalog and installed
with source `bootstrap`, pre-approved (snapshot source `bootstrap`) and enabled; a raised version
upgrades a plugin still at its bootstrap version, a higher one is never downgraded, and an entry
that left the manifest only loses `required`. A required plugin is enabled in every organization
without an org config row and cannot be disabled or uninstalled (409 `extension.required`); `start()`
refuses to serve when a required entry cannot be installed. `KernelOptions.builtinExtensions`, the
`builtin` extension source and `extension.builtin` are removed. The testing harness takes
`bootstrap: { dir, manifest }` instead of `builtinExtensions`.

The CLI no longer depends on `@capybara-hq/plugin-openai-compatible` or
`@capybara-hq/plugin-object-store-s3`. `capybara bootstrap [--dir <path>] [--manifest <path>]` runs
the bootstrap step from the packages in `/app/bootstrap`, which the kernel image now carries (packed
from the workspace and checked against `bootstrap.json` at build time); compose `init` runs it
between `migrate` and `admin create`, and `capybara start` runs it too when it finds the step not
done (`--bootstrap-dir`, else `/app/bootstrap` when it exists). The CLI's object store (plugin
imports with files) may now be an enabled, approved install record such as the bootstrap
object-store-s3, and `capybara extensions list` shows bootstrap plugins with source `bootstrap` and
desired state `required`.
`capybara bootstrap` exits 1 when a required entry fails or a package is missing or tampered, and
exits 0 with warnings when only optional entries still fail after its second pass (as `start` does).
The org extensions page shows required plugins as "Required" with a read-only switch.
