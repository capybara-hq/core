---
"@capybara-hq/testing": patch
---

The sandbox permission conformance follows approval-only profiles: every profile is sandboxed
(Full access included), the environment network comes only with the device filesystem (the
escalated pair, refused as invalid otherwise) and runs only with outside-sandbox support while the
owner allows it, and new fixture inputs prove the open network (closed classes refused by resolved
address, rebinding and fake-IP names included), closed classes behind allowlisted names, the
minimal environment (`deviceEnvironment`), the reserved staging prefix, protected link chains
(`home`), own-loopback connects and `SO_REUSEPORT` refused where listening is allowed, and an
instance-boundary profile for cloud providers (`instanceNetwork`). The fixture field
`restrictedEnvironment` is gone; `runSandboxPermissionConformance` takes `parts` to split a run.
