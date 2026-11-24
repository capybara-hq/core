---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The bootstrap step retries each npm package download (registry lookup and tarball) up to three
times with backoff when it fails transiently (a dropped connection, a timeout, HTTP 408 / 429 /
5xx), never on a 404 or a package that differs from its pin; the final error still names the
plugin. Docker Compose upgrades now run `docker compose run --rm init` before `docker compose up
-d`, so a failing migration or bootstrap no longer takes the serving containers down.
