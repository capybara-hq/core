---
"@capybara-hq/plugin-sdk": patch
---

Device services and streams for browser use: `device-provider@1` gains optional `ensureService`,
`stopService`, `serviceRequest` and `openStream` (`DeviceServiceSpec`, `DeviceServiceStatus`,
`DeviceStream`); the service socket protocol (`encodeServiceMessage`, `ServiceMessageDecoder`,
`DEVICE_SERVICE_*`); dial-in stream frames (`stream-open` / `stream-opened` / `stream-data` /
`stream-credit` / `stream-close`, `DIAL_IN_STREAM_INITIAL_CREDIT`), `DialInChannel.openStream` and
`DialInStreamElsewhereError`; and `permissions.deviceAccess` with `ctx.deviceAccess`
(`DeviceAccessCtx`, `DeviceAccessError`).
