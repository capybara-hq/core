---
"@capybara-hq/plugin-sdk": minor
---

A device answers which directories it can read, so the kernel can keep a device's projects itself.

`DeviceOp` gains `list` (`DeviceListArgs` `{ path, limit, limits }`: one directory's entries,
sorted by code unit, at most `MAX_DEVICE_LIST_ENTRIES`, with `truncated`, or null for a path that
does not exist) and `scan` (`DeviceScanArgs` `{ base, limits }`: the directories at most
`MAX_DEVICE_SCAN_DEPTH` levels below `base` that hold `.git` or `AGENTS.md`, at most
`MAX_DEVICE_SCAN_RESULTS`, as `DeviceProjectCandidate` `{ path, suggestedName }`). Both carry the
kernel's current ceiling (`DeviceRequestCeiling`, `{ mode }`) and are answered in the mode it gives.
Entry names are never `.` or `..`; `isDir` follows symbolic links (a dangling link is `false`);
paths are absolute and checked with `validateSandboxPathShape`; a `suggestedName` obeys
`isDeviceProjectName` (`MAX_DEVICE_PROJECT_NAME_LENGTH`). A device announces both with the new
`projects` feature, and the kernel sends them only to a device that did. A path the request's mode
cannot reach is an error, never null; a missing scan `base` answers `[]`. `scan` includes `base`
itself, follows no symbolic links, enters no hidden directories, keeps descending past a hit, skips a
directory whose basename is not a valid name, and keeps the first results by path in code-unit order.
`isDeviceProjectName` also refuses `.`, `..` and leading or trailing whitespace. `DeviceHello` gains
`home?: string`, the owner's home directory. `SandboxProvider` gains optional
`list(h, path, { limit, limits, signal })` and `scan(h, base, { limits, signal })` with the same
results; a provider without them offers no projects, and its conversations stay in free mode.
