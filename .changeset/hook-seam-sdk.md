---
"@capybara-hq/plugin-sdk": minor
---

Hook payload and manifest fixes before 0.1.0. `model.request` payloads no longer carry media: each
image or document block of `request` is a `HookMediaPlaceholder` (`kind`, `mediaType`, `size`; no
bytes, no attachment id), typed as `HookModelRequest`. `model.request`, `model.response` and
`usage.report` payloads gain `purpose` (`"step"` or `"compaction"`): compaction calls now fire the
model hooks and are reported. New manifest field `permissions.policyHooks` (only `POLICY_HOOKS`, each
also in `permissions.hooks`): `mode: "policy"` needs it, and deployment state uses it to fail calls
closed where the plugin is not loaded. `POLICY_HOOKS` is now a const tuple with the `PolicyHook` type.
Documented that `model.response` does not fire for aborted or unsent calls.
