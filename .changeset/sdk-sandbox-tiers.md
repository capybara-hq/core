---
"@capybara-hq/plugin-sdk": minor
---

Sandbox tiers: `SandboxTier` (`strict` < `dev` < `open`), `SANDBOX_TIERS`, `isSandboxTier`,
`compareTiers`, `tierAtMost`, `minTier` and the dev hosts preset `DEV_HOSTS`. `SandboxLimits`
requires `tier` and `devHosts` and may carry `defaultTier`; `SandboxProvider` gains the optional
`update(h, limits, signal)` and `limitsApplyAt`. Device protocol: the local policy summary replaces
`network` with `tier` (absent = follows the org), `effectiveTier`, `isolation`, `localhost` and
`unixSockets`; the hello feature `tiers`; the `policy` op takes `tier` (null = follow the org) and
`isolation: "sandbox"` instead of `network`. `DeviceNetworkMode` is removed.
