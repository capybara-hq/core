---
"@capybara-hq/testing": minor
---

The fake channel server records file uploads (`POST /send-file`: `sentFiles`, `duplicateFiles`, `failNext` / `delayNext` accept the path) and `fake-im` implements `sendFile` with `features.files`. The dual-replica harness stops one replica gracefully with `stopReplica(index)`.
