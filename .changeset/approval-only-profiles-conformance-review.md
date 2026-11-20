---
"@capybara-hq/testing": patch
"@capybara-hq/kernel": patch
---

The permission conformance returns a report of what it could not prove (with the fixture's
reasons), takes `checks` for focused runs, refuses empty `parts` or `checks`, and requires the
approval-only inputs of a provider with restricted support (`deviceEnvironment` with an
innocent-looking planted name, `closedGranted`, `home`, and `withoutOutsideSandbox` with outside
support). A sandboxed command's environment must hold only the minimal names, an open network needs
a reachable public target unless `allowNoPositive` is set, its closed targets must cover every closed
address class, and an instance boundary needs a metadata name behind its allowlist and refuses an
ungranted name a scope asks for. The kernel answers a device's scope validation refusal with a fixed
tool error and logs it as a kernel invariant break.
