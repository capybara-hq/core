---
"@capybara-hq/web": minor
"@capybara-hq/design": minor
---

The device page gains a network section for the owner of a local device: the machine's allowed
domains with remove, an add field that takes `*.` wildcards, the 「不限网络」 switch behind a
confirmation with the risk text, whether the machine accepts changes from the platform
(`remoteGrants`, set only on the machine) and the recent changes. The device picker and the
properties panel mark a device with no network limit (`PickerItem.badge`,
`ContextSection.sandboxBadge`).
