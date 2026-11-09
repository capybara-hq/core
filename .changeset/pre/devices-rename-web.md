---
"@capybara-hq/web": patch
"@capybara-hq/design": patch
---

One name: devices. The 环境 / Environments page is now 设备 / Devices at `/devices` and
`/devices/[id]`; 新建设备 offers 云端 / 本地 (cloud and local devices). The sign-in confirmation
page moves from `/device` to `/devices/link`; `/device` and `/environments` are the app's 404. The
composer's picker, the properties panel and all copy say 设备 / device. The design system's
composer picker prop `pickers.environment` is now `pickers.device` (reference blocks
`composer-device` and `composer-device-locked`).
