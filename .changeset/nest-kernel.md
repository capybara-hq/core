---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The kernel is being refactored into a standard NestJS application: shared infra modules (config,
logging, database with `@Transactional`, Redis) come first, with no change in behaviour.
