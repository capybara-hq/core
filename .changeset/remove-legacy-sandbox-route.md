---
"@capybara-hq/capybara": patch
---

The kernel's legacy sandbox route is gone: `SandboxService.withSandbox`, the protocol-2 held
provider, the builtin tools' legacy entry and `device_paths` writer, and the
`PERMISSION_CONTEXT_ACTIVATION` test seam with every dormant branch behind it. Every device use is
now an operation invocation, a trusted preparation or a kernel read. Production already took only
these routes, so nothing changes for a deployment; `device_paths` events already in logs still
render and replay as before.
