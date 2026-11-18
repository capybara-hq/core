---
"@capybara-hq/device": patch
"@capybara-hq/kernel": patch
---

Staged instance binding (fix round 1): one operation supervisor owns a device's journal at a time,
so binding a new generation drains the old backend, re-checks unsettled work after its last await
and disposes the old supervisor before the new one reads the journal. Bindings are stored per
device with the machine credential; the kernel names as previous the last binding it committed for
the machine, so a lost answer, a re-login or a shared state directory no longer deadlocks the
chain. Old binding records are pruned; the environment fingerprint covers every module the Python
helpers import.
