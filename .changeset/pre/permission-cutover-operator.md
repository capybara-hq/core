---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`capybara permissions cutover report | freeze | snapshot` drive the permission runtime cutover. The
report shows the pre-checks (local devices without a boot identity, cloud devices with unknown
incarnations), live replicas on another version, legacy rows only an old unfenced replica writes, the
freeze, the retirement obligations and the cloud snapshot's progress. The freeze returns only once
its enumeration settled and records it (migration 0158); the snapshot runs the new cloud snapshot
driver behind that barrier, under each device's lifecycle lease, idempotently and resumably. The
report and the freeze need PostgreSQL only; `--json` prints machine-readable output.
