---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

`ctx.dialIn.capacity(deviceId)`: the negotiated `maxFrameBytes` of the machine's current
connection (the value the kernel sent in `ready`: the smaller of the machine's announced cap and
`devices.dialIn.maxFrameBytes`), or null when no machine holds the device. Read from the holder's
Redis record under its lease, so any replica answers; only for the calling provider's own devices.
