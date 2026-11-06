---
"@capybara-hq/testing": patch
---

The fake git server no longer throws `ERR_HTTP_HEADERS_SENT` (an uncaught exception) when `git http-backend` cannot be spawned: the child's `error` and `close` events no longer both write the 502 head.
