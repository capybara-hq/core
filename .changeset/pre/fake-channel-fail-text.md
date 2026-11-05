---
"@capybara-hq/testing": patch
---

`FakeChannelServer.failNext` takes a match object as its last argument: `{ chatId, textIncludes }`
fails only requests to that chat whose message text contains the string. A string still means a
chat id.
