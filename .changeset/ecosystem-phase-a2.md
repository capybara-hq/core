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
