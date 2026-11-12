---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": minor
"@capybara-hq/web": minor
"@capybara-hq/design": minor
---

Network asks: when a command on a connected device is refused a domain by the device's local
policy, the device owner is asked in the conversation or on the IM card (「这次允许 / 这台设备一直允许 /
拒绝」). "This time" allows the domain for the rest of the run tree; "always" adds it to the device's
local policy through the new `policy` device operation. Org-layer and address-layer refusals are
explained to the model and shown under the command. Migration 0114 adds approval kinds and device
policy summaries.
