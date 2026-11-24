---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/testing": patch
---

Dial-in device streams: `ctx.dialIn.openStream` opens a credit-controlled byte stream to a machine
straight over its socket on the gateway replica holding it (`stream-open` / `stream-data` /
`stream-credit` / `stream-close`, never through Redis or PG); another replica throws
`DialInStreamElsewhereError`. The holder records its internal address under
`capk:device-holder-addr:<deviceId>` next to its lease (new config `gateway.internalUrl`, default
`http://<hostname>:<http.port>`). `FakeDialInMachine.onStream` serves streams in tests.
