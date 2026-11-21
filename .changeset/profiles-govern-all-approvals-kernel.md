---
"@capybara-hq/kernel": minor
---

Behavior change: tool asks addressed to a conversation's owner no longer raise a person card under
Approve for me or Auto; the permission profile now decides every such approval (Request approval
asks, Approve for me lets the review model decide and asks when it is unsure, Auto, renamed from
Full access with the identifier `full-access` unchanged, runs and records). Each automatic decision
is one `tool_ask_decided` event and one `tool.ask_auto_decided` audit row. Approvals for another role
or account, policy denies, ceilings, unattended runs and tools that require a person to act are
unchanged.

- Conversations from chat apps default to Approve for me, so their tool asks go to the review model.
- Secret fields are a separate secure input request (approval kind `secure_input`, migration 0175),
  asked under every profile after the call's own consent; the web submits it.
- The initial password and the invitation link are read by call:
  `POST /api/v1/orgs/:orgId/conversations/:conversationId/runs/:runId/calls/:callId/initial-password`
  and `.../invitation-link` replace the approval-keyed routes.
- A device without scoped operations keeps every profile selectable; only its device tools refuse,
  with the cause (`provider-outdated` or `runtime`) on the permission views.
- Upgrade the kernel first, then devices (the device protocol gains the error kind `unsettled`).
- The desktop and mobile clients follow in a later release for secure input and the reveal routes.
