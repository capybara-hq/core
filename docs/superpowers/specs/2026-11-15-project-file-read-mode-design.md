# Current mode on local project file reads

## Problem and evidence

A project can be added using an auto-mode `list`, yet its initial `stat` and AGENTS.md reads
fall back to the OS sandbox until an exec has supplied a fresh decision. A prior auto exec can
also incorrectly widen a later read whose current ceiling is sandbox. Both are reproduced in
`packages/device/test/server-ops-read.test.ts` before the fix.

## Resolution

Keep sandbox@2 unchanged. The kernel-internal local provider resolves current limits on every
`stat` and `readFile`, then sends their mode through required DeviceRequestCeiling fields in
protocol v2. The device validates the ceiling and intersects it with the current local policy.
The switching executor routes reads directly by that request, exactly as list and scan already do.
No warming command, cached execution decision or broader read permissions are introduced.

Protocol v1 cannot express these reads safely, so the existing version negotiation refuses it;
update the kernel and device together. Writes retain their reviewed-command window. Existing
project-root events continue recording what was actually read; no prompt or event format changes.

## Alternatives

Using a warm-up exec is rejected because it adds an execution side effect and races other runs.
Using the local policy alone is rejected because it loses the org ceiling. A required current
ceiling preserves both authorities and removes the dependency on previous commands.

## Validation

Test reads before any exec, ceiling narrowing after an auto exec, a local switch to sandbox,
missing/invalid ceilings, live provider limits instead of stored handle limits, and rejection of
old protocol connections. Run device and protocol suites, local-provider integration tests,
SDK API generation, type checking and repository checks. Reconnect the registered local device
without replacing its credentials, policy, projects or files, and verify real project reads.
