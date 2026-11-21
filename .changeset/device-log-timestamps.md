---
"@capybara-hq/device": patch
---

Date every line `capybara-device start` writes to stdout and stderr (the service log), and its
uncaught exceptions, with a local ISO-8601 timestamp and offset. Other commands stay plain.
