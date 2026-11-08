# Capybara

**An open-source, self-hosted agent platform for companies.** People in your organization create AI
agents, connect them to your models and internal tools, and use them from the web app, Slack or
Lark, with admins in control of what is installed, who can use it and what an agent may do.

Apache-2.0. TypeScript, Node 24.

## What it does

- **Agents for everyone in the org.** Create an agent with its own instructions, model, tools and
  skills; share it with the org or keep it private; talk to it in the web app or in Slack / Lark.
- **Any model.** OpenAI-compatible services (DeepSeek, Qwen, vLLM, …), Anthropic and OpenAI, each
  as a plugin. Several at once.
- **Your tools.** Connect remote MCP servers and HTTP APIs described by OpenAPI, with shared or
  per-person credentials and OAuth. Write actions ask for approval first.
- **A sandbox per conversation.** Agents run commands, edit files and hand back results in an
  isolated Docker or E2B sandbox with controlled network access.
- **Company sign-in and directory.** Sign in with Slack or Lark, and sync members from the directory.
- **Governance.** Admins decide which plugins the organization may install, approve their
  permissions, and keep an audit trail.
- **Replay and evals.** Every conversation is an event log: inspect what the model saw, replay a run
  against another model or prompt, and compare.
- **Runs on your infrastructure.** PostgreSQL, Redis and S3-compatible storage; scales out with
  several replicas; works fully offline.

Everything beyond the small kernel is a plugin: models, channels, connectors, sandboxes and storage
all install, upgrade and uninstall without a restart.

## Try it in 5 minutes

Run a complete deployment on one machine with Docker Compose: PostgreSQL, Valkey, S3 storage, the
kernel and the web app. You need Docker with Compose v2.23 or newer, git and openssl.

```bash
git clone https://github.com/capybara-hq/core.git
cd core
# the latest stable release (prerelease tags such as v0.2.0-rc.1 are skipped)
tag="$(git describe --tags --abbrev=0 --match 'v*' --exclude 'v*-*' 2>/dev/null)" \
  && git checkout "$tag" \
  || echo "No stable release tag yet: staying on main, whose images may not be published yet."
cd docker
{
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "CAPYBARA_MASTER_KEY=$(openssl rand -base64 32)"   # encrypts stored secrets: back it up
  echo "CAPYBARA_S3_ACCESS_KEY=$(openssl rand -hex 24)"
  echo "CAPYBARA_S3_SECRET_KEY=$(openssl rand -hex 24)"
  echo "CAPYBARA_SETUP_TOKEN=$(openssl rand -hex 16)"     # the setup page asks for it
} > .env
docker compose up -d
docker compose ps -a     # createbuckets and init exit 0, the other services become healthy
```

1. Open <http://localhost:3000> (use `localhost`: over plain http on another host name, browsers
   drop the session cookie). The setup page creates the super admin and the first organization;
   enter the setup token from `.env` (`grep CAPYBARA_SETUP_TOKEN .env`).
2. Install `model-fake`, a scripted model that needs no API key: Admin → Extensions → Install
   extension, enter `@capybara-hq/plugin-model-fake`, review the permissions, approve and enable. Or
   from the shell:

   ```bash
   docker compose exec api node /app/bin/capybara.mjs extensions install npm:@capybara-hq/plugin-model-fake --yes
   docker compose exec api node /app/bin/capybara.mjs extensions approve model-fake --yes
   docker compose exec api node /app/bin/capybara.mjs extensions enable model-fake
   ```

3. Create an agent with the model `model-fake/fake-1` and send `echo:hello`.

For a real model, configure `openai-compatible` under Admin → Extensions (it is always installed), or
`anthropic` / `openai` / `deepseek` / `bailian` (Alibaba Cloud Model Studio) / `ark` (Volcengine Ark)
(preinstalled, off in each organization until an org admin switches them on
in Plugins); see [Models](docs/guide/models.md). The official plugins live in
[capybara-hq/plugins](https://github.com/capybara-hq/plugins). `.env.example` lists the optional
settings (image version, port, public URL).

## Documentation

| | |
|---|---|
| [User guide](docs/guide/README.md) | Extensions, models, connectors, Slack and Lark, storage, sandbox, skills, evals, the catalog |
| [Deployment](docs/deploy/README.md) | HTTPS and the public URL, roles and scaling, IM webhooks, Kubernetes; [upgrades](docs/deploy/upgrade.md) |
| [Configuration](docs/config.md) | Every config key and its environment variable |
| [Development](docs/development.md) | Running from source, the dev kernel and web app, checks |
| [Writing plugins](https://github.com/capybara-hq/plugins) | The plugin SDK, author guides and reference plugins |
| [Contributing](CONTRIBUTING.md) | Issues, pull requests and review; [AGENTS.md](AGENTS.md) is the guide for coding agents |

Capybara is on 0.x: the plugin SDK and the HTTP API may change between minor versions, and the
release notes describe each breaking change.

## License

[Apache-2.0](LICENSE)
