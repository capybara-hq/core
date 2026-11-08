---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
"@capybara-hq/design": patch
---

Agents gain the `Platform` builtin tool, on for new agents: an agent browses, searches and describes
the platform's operations, calls them as the person who started the run, and reads the agent docs.
Operations cover skills, agents, agent templates, plugins, marketplaces, requests, connectors and
extensions (`skills.*`, `agents.*`, `plugins.*`, ...); results never carry secrets, and a super admin
sees other orgs as counts only. Reads run; writes ask the person to confirm, and org and platform
writes are confirmed every time and never remembered (`approval.scope_not_allowed` for any other
scope). Tool policies can be keyed per call (`Platform:<operation>`); an approval stores its
kernel-rendered summary (zh and en) and runs only with the exact input it showed. Confirmations show
the operation and the summary on the web and in IM cards, and offer only the scopes the approval
allows. Orgs gain the `platformTool` setting (`on` / `read-only` / `off`, default on) on the
organization settings page; writes are unavailable when no person is present. Audit events of writes
made through the tool carry `{ via: "agent", conversationId, runId, operation }`. `describe` lists an
operation's notable errors and paged lists take `params.cursor`. `check:platform-ops` fails a kernel
HTTP route that has neither an operation nor a reasoned exclusion.
