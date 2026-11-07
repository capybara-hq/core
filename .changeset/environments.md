---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
---

Environments (phase 1, spec 2026-11-07-environments-design): conversations run their sandbox tools
in a person's environment instead of a sandbox of their own. Each member gets a default personal
environment per org (created on first need) and can create more, at most `environments.maxPersonal`
(new config, default 10, hot). A conversation is bound to one environment when it is created
(`environmentId` on `POST /api/v1/orgs/:orgId/conversations`, else the owner's default) and keeps
it; its sub-agents share it, and access is checked on every sandbox tool call. New API
`/api/v1/orgs/:orgId/environments`: list, create, get, rename, delete (the instance and files are
destroyed by a job) and `POST /:id/files/reset` (a `sandbox-reset-files` job empties lost files,
202). In IM, `/env` in a direct message lists the person's environments and `/env <name>` picks the
one the next new conversation uses. Instances are suspended and destroyed when idle; files stay
until the environment is deleted. Attachments go to `/workspace/attachments/<conversation>/` and
skill files to `/skills/<name>@<digest>/`. The kernel drives `sandbox@2` providers only (separate
file systems and instances; a `sandbox@1` plugin is refused). `sandbox.image` has no default any
more: unset, each provider uses the image published with its own version. The worker job
`environments-legacy-cleanup` destroys the per-conversation sandboxes of earlier versions (the
legacy `sandboxes` rows; rows of a provider that is not loaded are kept). The web app has an
environments page and an environment picker before the model in the composer.
