---
"@capybara-hq/kernel": minor
---

The kernel keeps a device's projects in PostgreSQL (`device_projects`, migration 0133), the same for
a local machine and a cloud device. Owner-only routes under `/api/v1/orgs/:orgId/devices/:id/projects`
list the projects the device's current mode can read (the others are hidden, not deleted), add one
(`{ path, name? }`: `path` relative to the workspace in sandbox mode and on a cloud device, to the
owner's home in auto mode; the device is asked with `list` first), remove one (idempotent) and ask
the device for suggestions (`/candidates`, one `scan`). Each route has a Platform operation
(`devices.list-projects`, `devices.add-project`, `devices.remove-project`,
`devices.project-candidates`). The `@local` provider forwards `list` and `scan` to machines that
announce `projects`; a machine's hello `home` is stored with it. Conversations gain the nullable
`project_name` and `project_path` columns a binding will use.
