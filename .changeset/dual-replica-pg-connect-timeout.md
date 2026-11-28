---
"@capybara-hq/testing": patch
---

Raise the dual-replica harness PostgreSQL connect timeout to 30 s so replicas do not fail to start on loaded CI runners.
