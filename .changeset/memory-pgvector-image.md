---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

The compose files and test containers run PostgreSQL 17 with pgvector (`pgvector/pgvector:pg17`),
and migration 0119 creates the `vector` extension in `public` when the server offers it and the
migrating role may create it; otherwise it only raises a notice, and plugins fall back to `real[]`.
`@capybara-hq/testing` exports `startPostgresContainer` (with an `image` option) and `TEST_PG_IMAGE`.
