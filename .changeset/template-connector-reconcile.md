---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/testing": patch
---

The first start after this release creates, once across replicas (under `lock:bootstrap`), the
connectors that plugins installed earlier still lack: every connector template on in an org with
no connector there becomes one under the install rule (`needs_config` when it needs an org
credential or OAuth client). It runs once per deployment, so a template connector an admin deletes
later is not made again. The dual-replica harness takes `beforeStart` to seed the fresh database
before the replicas start.
