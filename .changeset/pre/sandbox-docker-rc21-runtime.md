---
"@capybara-hq/capybara": patch
---

Bootstrap and the compose sandbox profile move to sandbox-docker 0.1.0-rc.21, whose image stages the
current SDK runtime: with rc.20 a current kernel refused every cloud device with "The staged
native-files.py does not match its digest".
