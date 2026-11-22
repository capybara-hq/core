---
"@capybara-hq/kernel": patch
---

The device sign-in chooses a dial-in provider: `POST /api/v1/device/authorize` takes the program's
`protocol`, `GET /api/v1/device/providers?orgId&userCode` lists the dial-in providers on in the org
that speak it (each with the person's devices of it), and `POST /api/v1/device/confirm` takes
`provider` (`device.provider_unavailable` unless it is on in the org and speaks the code's
protocol). A connection whose device was deleted closes as "the device was deleted" at its
periodic credential re-check too.
