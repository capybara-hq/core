---
"@capybara-hq/testing": minor
---

The fake Slack, Lark and Telegram servers accept file uploads (`files` / `uploads` records, multipart `sendPhoto` / `sendDocument`, Lark `im/v1/images` and `im/v1/files`).

`startFakeSlack`'s `failNext("upload", …)` and `delay("upload", …)` also reach the `POST /upload/<id>` step of the external upload flow.
