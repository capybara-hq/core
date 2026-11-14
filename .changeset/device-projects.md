---
"@capybara-hq/plugin-sdk": minor
---

A device reports the projects it serves, and a sandbox provider can list a directory.

`DeviceLocalPolicySummary.projects` (`DeviceProject[]`: a name and a directory on the machine) is
always present after parsing, `[]` when the device serves none or predates projects, so a project
can be added and picked from the web instead of a terminal. `DeviceOp` gains `projectList`,
`projectCandidates`, `projectAdd` and `projectRemove` with their args and results.
`SandboxProvider.list` (optional) lists a directory's entries sorted by name and returns `[]` for a
directory that does not exist; a provider without it serves no projects, and its conversations stay
in free mode.
