---
"@capybara-hq/device": minor
---

`login --json`, `ceiling show --json` and `service status --json` print machine-readable output so
a desktop app can drive the CLI. `login --json` writes one JSON event per line to stdout (human
lines go to stderr) and opens no browser.
