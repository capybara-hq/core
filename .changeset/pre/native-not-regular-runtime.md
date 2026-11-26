---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

The SDK's current `native-files.py` answers a read or write of a FIFO, device or other special file
with `NOT_REGULAR_FILE` (a `NotRegularFile` error), mapped by `nativeFailureText` (core#907). Step 1
of the runtime change: `SANDBOX_RUNTIME_SOURCE.files` keeps the staged helper byte for byte
(`sandbox-native-staged-runtime-source.ts`), `current` and `accepted` carry the new digest.
capybara-device, which always runs `current`, recognizes the error by its class.
