# Conversation sandbox

Each conversation can get its own sandbox to run commands and produce files. Two implementations exist: Docker and E2B.

## Docker

Sandboxes are provided by a `sandbox@1` extension, and the Docker implementation is `@capybara-hq/plugin-sandbox-docker`: one container per conversation (runc, or gVisor's runsc), files on a volume, hibernated when idle and destroyed after long disuse; egress is allowed through a proxy by allowlist by default. The extension reaches Docker only through the socket proxy (`docker/sandbox-proxy`) and doesn't mount `docker.sock` itself. Locally:

```bash
docker compose -f docker/compose.dev.yaml --profile sandbox up -d   # builds the sandbox and egress proxy images from capybara-hq/plugins (git + GitHub), starts the socket proxy (127.0.0.1:2375)
pnpm capybara extensions install npm:@capybara-hq/plugin-sandbox-docker --yes   # then approve and enable it
export CAPYBARA_EXTENSION_CONFIG='{"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375"}}'
```

Production deployment:

- **Images**: `docker build -t capybara-sandbox:latest https://github.com/capybara-hq/plugins.git#<commit>:plugins/sandbox-docker/image` (the tag matches the default of the kernel config `sandbox.image`) and `docker build -t capybara-sandbox-egress:latest https://github.com/capybara-hq/plugins.git#<commit>:plugins/sandbox-docker/egress-proxy` (`<commit>`: the one `docker/compose.yaml` builds, `marketplace.commit` of `packages/kernel/bootstrap.json`); after pushing them to your own registry, **pre-pull them on every Docker node** (when the image isn't local, it is pulled the first time a sandbox is used, which may run past that tool call's time limit). To use gVisor, first register `runsc` in the daemon and add `"runtime":"runsc"` to the extension config.
- **Where the socket proxy lives**: anyone who can reach the proxy can almost fully control Docker. `127.0.0.1:2375` is for local development only; in production, **never publish it on any host address (including 127.0.0.1)**; put it only on an internal network the kernel is on (set `endpoint` to `tcp://sandbox-proxy:2375`), and don't attach sandboxes to that network.
- **Egress**: `sandbox.limits.egress` defaults to `allowlist`, which allows only `sandbox.limits.allowHosts` (preloaded with npm, PyPI, and GitHub's clone, archive, raw and release download addresses; Debian mirrors are not preloaded: the sandbox user has no sudo and can't install apt packages, so install system packages into the image), and the proxy rejects internal-network and cloud-metadata addresses by resolved IP; `none` cuts the network; `open` requires explicitly turning on the extension config `allowOpenEgress` (off by default) and should be used only in trusted environments. Org admins can change their org's sandbox network in org settings (`sandboxEgress`): replace it with a different allowlist (replacing the deployment's list) or cut the network, but can't be more permissive than the deployment (there is no `open`, and when the deployment is `none` the only choice is `none`). Changes to egress and resource limits affect only sandboxes created afterward. The default local volume driver doesn't enforce `diskMb`.
- **Long commands need a relaxed runtime limit**: a single command may run for at most `sandbox.limits.maxCommandSeconds` (default 7200 seconds), but a command is also stopped shortly before its run reaches `runtime.maxRunSeconds` (default 900 seconds) (the result tells the model it was due to the run time limit). When an agent needs to run long commands, raise `runtime.maxRunSeconds` to at least `maxCommandSeconds`; when this isn't satisfied, the kernel logs a warn at startup.

Once you add the builtin tools `Bash` / `Read` / `Write` / `Edit` / `Glob` / `Grep` / `Deliver` to an agent, it can use the sandbox (not included by default). Sandbox tools execute directly by default. **The sandbox isolates the host and the internal network, not data**: the egress allowlist blocks internal-network and cloud-metadata addresses, but can't stop data from being sent to hosts on the allowlist (for example `git push` to github.com, or publishing to npm); attachments in the conversation and any data the agent can read may flow out this way. For orgs that handle sensitive data, admins should change `sandboxToolPolicy` to `ask` in org settings (write, execute and deliver need approval), and / or set the sandbox network (`sandboxEgress`) to no network. Attachments are placed automatically in `/workspace/attachments/`, and files delivered with `Deliver` appear in the "Artifacts" tab on the right of the conversation page. A sandbox hibernates after 10 idle minutes (files are kept) and is destroyed after 7 days of disuse, see `sandbox.*` in `docs/config.md`. For config options, isolation settings, disk limits and egress allowlist details, see [the sandbox-docker README](https://github.com/capybara-hq/plugins/blob/main/plugins/sandbox-docker/README.md); to write sandbox extensions, see [.agents/skills/writing-sandbox-providers](../../.agents/skills/writing-sandbox-providers/SKILL.md).

## E2B

The other implementation is `@capybara-hq/plugin-sandbox-e2b` (an alternative to Docker): one E2B sandbox per conversation (E2B cloud or self-hosted), hibernation uses E2B's pause and resuming uses connect, pausing automatically on schedule instead of deleting; the egress allowlist maps to E2B's `allowOut` / `denyOut` (by domain, covering only ports 80 / 443). The template is built from the same [`image/Dockerfile` of sandbox-docker](https://github.com/capybara-hq/plugins/blob/main/plugins/sandbox-docker/image/Dockerfile):

```bash
pnpm capybara extensions install npm:@capybara-hq/plugin-sandbox-e2b --yes   # then approve and enable it
export CAPYBARA_EXTENSION_CONFIG='{"sandbox-e2b":{"apiKey":"e2b_…","template":"capybara-sandbox"}}'
```

- **Template**: build it from the Dockerfile with E2B's Template SDK (`Template().fromDockerfile(...)`, with `cpuCount: 1` and `memoryMB: 2048` matching the kernel defaults), and put the template name into `template`; rebuild the template after changing the Dockerfile. E2B's CPU, memory and disk are determined by the template, so these three `sandbox.limits` settings have no effect on it, and the kernel config `sandbox.image` isn't used either.
- **Egress is weaker than Docker**: E2B's domain allowlist only looks at the Host header on port 80 and the SNI on port 443, and doesn't check the destination IP, so a sandbox may reach arbitrary addresses through a domain on the allowlist; when an allowlist is used, E2B also lets DNS to 8.8.8.8 through. Use Docker for deployments with strict egress requirements. For self-hosted E2B, block internal-network and cloud-metadata addresses yourself at E2B's network layer; for versions that don't support domain allowlists, set `domainAllowlist: false` (`allowlist` degrades to `none`).
- On the Hobby plan, the sandbox timeout is at most 1 hour, so set `sandbox.limits.maxCommandSeconds` below 3480.
- The sandbox CPU / memory overrides a super admin sets for an org in the admin console have no effect on E2B (the spec is determined by the template) and apply only to the Docker implementation.

For template build steps, self-hosting (`apiUrl` / `domain`), and the limits of egress and resource limits, see [the sandbox-e2b README](https://github.com/capybara-hq/plugins/blob/main/plugins/sandbox-e2b/README.md).
