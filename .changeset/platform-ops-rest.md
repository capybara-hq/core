---
"@capybara-hq/kernel": minor
---

Platform tool phase 2: the rest of the UI.

- **Inbox and pending reads.** These cover:
  - your inbox and the platform inbox;
  - approvals waiting for you (summaries, never the call's input);
  - pending requests;
  - extensions waiting for permission confirmation (permissions, never config);
  - dismissing notices.

  Decisions stay on the web.
- **Channels and org settings.** Channel connections are read without credentials (the webhook URL
  is included). An agent can change a channel's binding or remove it. Org settings can be read and
  changed, including the Platform tool switch, which applies from the next call.
- **Evals.** Sets, cases, runs, labels and estimates are available as metadata and scores only.
  Case content and outputs stay on the web, and cases are labelled "case <n>".
- **Connectors, agents and the rest.** Connectors can be refreshed and deleted. Agents can be
  deleted (never remembered) and have their versions read. A pending connector can be bound to an
  agent, and connector setup can be requested and its status read. Agent templates can be updated,
  shared and deleted. Background tasks can be listed and stopped (each stop is asked, never
  remembered). File previewers and model reads
  are covered too.
- **Environments** (personal): list, read, create and rename. Delete and files reset are never
  remembered, and their cards warn that files are destroyed and that bound conversations lose their
  sandbox. The environment the conversation itself works in is refused.
- **Agent skills and skill changes**: list and remove an agent's skills (shared agents are always
  asked) and list invocable skills. Skill changes can be read as a summary; deciding stays on the web.
- **Prechecks** deny known failures before the card.
- **Admin results.** Platform component writes name the orgs a component is on in and is named for.
  The platform inbox keeps the admin console's total when more than 100 items wait, and says how
  many of the newest it listed.
- **Audit detail.** A write made through the Platform tool records
  `{ via: "agent", operation, agentConversationId, agentRunId }`, so the row's own `conversationId` /
  `runId` (an eval case's source run, for example) are no longer overwritten.
- **Tool description.** The `Platform` tool's description names the current operation families.
  Its spec hash changes once, so remembered `Platform` grants and approvals pending at deploy are
  asked again (never wrongly allowed).
