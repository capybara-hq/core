---
"@capybara-hq/testing": patch
---

The sandbox permission conformance runs on macOS as well as Linux: its shell, socket and rename
probes use forms both systems accept (`touch -t`, the BSD `sockaddr_in` layout, `renamex_np`),
UNIX socket types the OS lacks are reported as unsupported instead of failing, and a live
operation whose root is swapped may refuse the moved path as well as keep writing in place. Four
optional fixture fields state a runtime's documented differences instead of skipping checks:
`foldedNames` (mandatory denies matched as the filesystem resolves names),
`restrictedLoopbackListen` (no restricted listener at all), `regroupedDescendants` (a descendant
that leaves the process group is outside the cancellation contract) and
`endpoints.namedReach` (no hermetic way to lead the allowlisted name to the endpoint).
