---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
---

Staged device protocol 3 gains the private `bindInstance` lifecycle request and its strict answer
parser (`BindInstanceRequestV3`, `BindInstanceResultV3`, `DeviceRuntimeIdentityV3`). The kernel
allocates each instance generation from a durable per-device high-water mark (no reuse after a
deleted row, a clock rollback or two creates in one millisecond), commits an awaiting binding for a
local instance and installs its runtime report only from the verified post-commit bind answer. A
bound hello re-reports only the installed identity; a changed identity stops admission, and a
changed environment resets Full consent. A reconnect no longer resets Full consent because stored
roots came back in another key order. Protocol 2 stays active.
