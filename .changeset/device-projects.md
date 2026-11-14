---
"@capybara-hq/plugin-sdk": minor
---

A device reports the projects it serves, and a sandbox provider can list a directory.

`DeviceLocalPolicySummary.projects` (`DeviceProject[]`: a name and an absolute directory on the
machine) is always present after parsing, `[]` when the device serves none or predates projects, so
a project can be added and picked from the web instead of a terminal. Projects are bounded
(`MAX_DEVICE_PROJECTS`, `MAX_DEVICE_PROJECT_NAME_LENGTH`, `isDeviceProjectName`,
`isDeviceProjectPath`). `DeviceOp` gains `projectList`, `projectCandidates` (answering
`DeviceProjectCandidate` suggestions), `projectAdd`, `projectRemove` and `list` (one directory's
entries, `MAX_DEVICE_LIST_ENTRIES`), with their args and results; a device announces them with the
new `projects` feature, and the kernel sends them only to a device that did.
`SandboxProvider.list(h, path, { limit, signal })` (optional) lists a directory's entries sorted by
code unit, with `truncated`, and returns null for a path that does not exist; a provider without it
serves no projects, and its conversations stay in free mode.
