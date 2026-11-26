---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

A failed native file operation names its cause (#907): the SDK's `nativeFailureText(code)` maps a
native helper's error code (`NOT_REGULAR_FILE`, `ENOENT`, `ENOTDIR`, `EISDIR`, `ENOSPC`, …) to
actionable English text, keeping the generic text for unknown codes. capybara-device's native
helpers answer `NOT_REGULAR_FILE` for a read or write of a FIFO, device or other special file, and
its macOS and Linux operation backends throw the mapped text instead of one generic message.
