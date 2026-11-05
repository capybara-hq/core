---
"@capybara-hq/testing": patch
---

`FakeChannelServer.failNext` takes an optional `chatId`: only requests to that chat count and
fail, so a late delivery to another chat cannot take a failure meant for the request under test.
