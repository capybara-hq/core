---
"@capybara-hq/plugin-sdk": minor
---

Auto mode replaces the sandbox tiers. `SandboxLimits` now carries `mode` (`auto` / `sandbox`) and
`network` (`{ kind: "open-public" | "allowlist", hosts }`) instead of tiers, egress and allowlists;
the device protocol reports a `mode` feature and a `{ mode, allowedDomains }` policy summary, and
the policy op may only narrow to `sandbox`. `ModelCallPurpose` and `UsagePurpose` gain `review`.
Removed: `SandboxTier`, `SANDBOX_TIERS`, `isSandboxTier`, `compareTiers`, `tierAtMost`, `minTier`,
`DEV_HOSTS`, `UNSANDBOXED_NOT_ALLOWED_MESSAGE`, `DeviceRemoteGrants`, and the old limit fields
(`egress`, `allowHosts`, `tier`, `defaultTier`, `allowUnsandboxed`, `devHosts`). A provider that
ignores the new fields runs as an allowlisted sandbox.
