---
"@capybara-hq/kernel": minor
---

Add the platform setting `devices.defaultProvider` (config field, `CAPYBARA_DEVICES__DEFAULT_PROVIDER`,
and the admin setting `devicesDefaultProvider`) naming the device provider that makes a person's
default device, with an org override `deviceDefaultProvider` (accepted only for a provider that is on
in the org, else `org.device_provider_not_available`).
