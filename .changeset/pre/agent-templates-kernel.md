---
"@capybara-hq/kernel": minor
---

Agent templates (plugin component management phase 4): any member creates a private agent from a
usable template (`POST /api/v1/orgs/:orgId/agents/from-template`, with `…/preview` and a `previewHash`
that goes stale with 409 `agent.template_preview_stale`; an org admin may choose another visibility).
The agent records its provenance (migration 0085: `created_from_template_id`, `_version`, `_name`) and
carries the connectors the org lacks as model-invisible `pendingConnectors`, bound with
`POST …/agents/:agentId/pending-connectors/:key/bind` or, for a member, requested through one
`connector_setup` inbox request per agent that the org admins configure or reject. Org admins save an
agent as an org template (`POST …/agents/:agentId/save-as-template`: platform connectors become
`{ template }` entries, others a "needs a connector" entry with no credentials) and edit, delete and
share org templates. Connector views name their platform connector template (`platformTemplateId`).
