---
"@capybara-hq/testing": patch
---

Permission conformance: `SandboxPermissionEndpoint` splits `host` into `name` (the host a scope
allowlists, validated with `validateAllowHost`) and `address` (the numeric address raw clients and
the pointer race connect to), and `endpoints.access` declares whether allowlisted traffic goes
`direct` or through the operation's HTTP `proxy` (positives then use curl and Python through
`http_proxy`, ungranted names must be refused by the proxy, and the race targets the proxy).
Readiness waits now race the operation that should create the file, so a refused or early-ending
operation fails at once with its error. The suite documents that other processes' `/proc/<pid>`
cmdline is not covered (a known launcher limitation).
