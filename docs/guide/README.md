# User guide

How to set up and use each part of Capybara once it is running. For a production deployment see
[docs/deploy](../deploy/README.md); for every config key see [docs/config.md](../config.md); to run
from source see [docs/development.md](../development.md).

| Page | What it covers |
|---|---|
| [Setup](setup.md) | Creating the first super admin and org, admin accounts from the CLI |
| [Extensions](extensions.md) | Installing, approving, enabling and upgrading extensions; deployment config; the trust model |
| [Models](models.md) | The model provider extensions (OpenAI-compatible, Anthropic, OpenAI, model-fake) and their config |
| [Tools and connectors](tools-and-connectors.md) | MCP and OpenAPI connectors, auth and OAuth, approvals and the inbox, tool drift, `ToolSearch`, the `Platform` tool |
| [Slack and Lark](slack-and-lark.md) | The IM bot, web login and directory sync |
| [Conversation page and extension UI](conversation-ui.md) | The right panel, extension tabs, schema views and embeds |
| [UI slots](ui-slots.md) | Every place extension UI can appear: scope, accepted kinds, minimum role, arguments (generated) |
| [Object storage](object-storage.md) | S3-compatible storage, CORS, attachments and image / PDF input |
| [Environments and sandboxes](sandbox.md) | Personal environments shared by conversations, on Docker or E2B; egress, limits |
| [Skills](skills.md) | The skill library, skills at run time, agents writing their own skills |
| [Evals and trajectories](evals.md) | The trajectory viewer, eval sets, step and full-run replay |
| [Catalog and marketplaces](catalog.md) | Plugins, scopes and platform components, marketplaces, import review, org install |
