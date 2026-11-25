---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

Dial-in stream data can travel as binary WebSocket messages. A machine's hello offers `transport.binaryStreamData` and the kernel's `ready` agrees; from then on both sides send `stream-data` as one binary message (`encodeDialInStreamData`: tag, stream id, the raw bytes) instead of base64 inside JSON, which cuts a quarter of the bytes of every device stream (the browser live view). `capybara-device` offers it; a machine that does not offer it stays on JSON, and a `capybara-device` whose offer an older kernel refuses (4400 before `ready`) reconnects without it, so the device and the deployment can be upgraded in either order. `FakeDialInMachine` takes `binaryStreamData` to test both.
