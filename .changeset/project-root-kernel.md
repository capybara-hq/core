---
"@capybara-hq/kernel": minor
---

A conversation can work in a project on its device: the agent reads the project's `AGENTS.md` and
skills at every run start and works inside the project's directory.

- **Projects**: kept in PostgreSQL (`device_projects`, migration 0133), the same for a local machine
  and a cloud device, at most 100 per device. Owner-only routes under
  `/api/v1/orgs/:orgId/devices/:id/projects` list the projects the device's current mode can read
  (the others are hidden, not deleted), add one (`{ path, name? }`: `path` relative to the workspace
  in sandbox mode and on a cloud device, to the owner's home in auto mode; a path holding the
  owner's home is refused as `device.project_path_too_broad` before the device is used; the device
  is asked with `list` first), remove one (idempotent) and ask the device for suggestions
  (`/candidates`, one `scan`). Each route has a Platform operation (`devices.list-projects`,
  `devices.add-project`, `devices.remove-project`, `devices.project-candidates`). The `@local`
  provider forwards `list` and `scan` to machines that announce `projects`; a machine's hello `home`
  is stored with it.
- **Binding**: `POST /conversations` takes `project`, a project of the conversation's device that its
  owner may read now; the binding (`conversations.project_name` / `project_path`) never changes, and
  the conversation view carries it with the latest project state.
- **Knowledge**: a bound conversation's run start reads the project's `AGENTS.md` (64 KiB) and its
  `.agents/skills/` names and descriptions (100) through the device and records a `project_root`
  event when anything changed; a project that is gone, outside the mode, unreadable or unsupported is
  recorded as unavailable and the conversation continues in free mode. Each event renders at its
  position as a system message (after the agent's own instructions, which win on a direct conflict;
  the skills listed as `project:<name>`), and the latest one follows a compaction summary again. A
  sub-agent's run copies its root's snapshot; full-run replays copy the run's events as recorded.
- **Working root**: a bound conversation's `Bash` runs in the project root, `Glob` / `Grep` search
  there by default and relative file paths resolve against it; the command review takes it as its
  workspace and judges home-level sensitive paths (shell rc files, SSH, credentials, launch agents
  and the like) against the owner's home in any case. A root above any home (`/`, `/home`, `/Users`
  in any case) or outside the workspace in sandbox mode falls back to the device's workspace.
- **Project skills**: `Skill` loads `project:<name>` by reading its `SKILL.md` on the device; the `/`
  menu lists them with `source: "project"`, and a person's send reads the file first, refused with
  `skill.project_unavailable` and its reason (an IM channel answers with the reason and posts
  nothing). The `project:` prefix is reserved.
