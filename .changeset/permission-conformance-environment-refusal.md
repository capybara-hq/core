---
"@capybara-hq/testing": patch
---

`SandboxPermissionFixture.restrictedEnvironment: "refused"` lets a provider whose policy refuses a
restricted filesystem with the environment network (a local device ties that network to Full
access) prove the refusal, a scope denial with nothing run, instead of the environment-network
UNIX probe.
