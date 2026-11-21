---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/device": minor
"@capybara-hq/testing": minor
---

An operation scope's filesystem is now `{ kind: "scoped", projectRoot, writeRoots }`: the scope
names the project root (null in free mode) and the roots the operation may write, and no longer
carries read roots; what a sandboxed operation may read is the device provider's rule. The scope
parser refuses a `readRoots` key. Device protocol goes to 5 (`DEVICE_PROTOCOL_VERSION`), and a
protocol 4 program is refused with 426 ("Update capybara-device"). `capybara-device` derives its
read roots from the write roots, the project root (the workspace in free mode) and its skills root;
an approved read outside the project is not conveyed to a local device for now. The permission
conformance suite sends the fixture root as the project root.
