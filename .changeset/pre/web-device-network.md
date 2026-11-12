---
"@capybara-hq/web": minor
"@capybara-hq/design": minor
---

The device page gains a network section for the owner of a local device: the machine's allowed
domains with remove, an add field that takes `*.` wildcards and whether the machine accepts changes
from the platform (`remoteGrants`, set only on the machine). Opening the network is the sandbox
level's 开放 (see the sandbox levels changeset). The device picker and the properties panel can mark
a device (`PickerItem.badge`, `ContextSection.sandboxBadge`).
