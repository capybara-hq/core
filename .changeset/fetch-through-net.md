---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

OAuth discovery, client registration and token requests, npm registry downloads (packument,
tarball, a marketplace's `tarball` URL, the bootstrap download) and npm provenance now go through
the kernel's network rules (`packages/kernel/src/net`): a host must resolve to public addresses
unless `marketplaces.allowPrivateHosts` lists it, the connection is pinned to the checked address,
redirects are never followed, and https requests tunnel through `net.httpsProxy`. An OAuth URL
whose host is private fails with reason `address_refused` and says how to allow it. The configured
`packages.npmRegistry` origin stays trusted (an internal or `http://` registry keeps working); a
deployment with `net.httpsProxy` and an internal https registry lists it in `net.noProxy`.
