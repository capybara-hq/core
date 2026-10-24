# M5 live environment acceptance checklist (sandbox: Docker runsc / E2B; images / PDFs with real models; skills)

The second-segment acceptance of M5 (Task 12) has three parts:

1. **Dual-replica acceptance** (automatic; runs in `pnpm test` when Docker is available and is skipped without Docker):
   `packages/kernel/test/sandbox/m5-segment2.dual.test.ts`: the real `sandbox-docker` plugin (runc, egress none),
   SeaweedFS object storage, and two kernel subprocesses: upload an attachment → process it with `sandbox_bash` → deliver it with `sandbox_deliver` and download it →
   after killing the replica running the run, the other replica resumes it and reuses the same container → resume after idle hibernation. About 70 seconds on a local machine (about 60 of them waiting for the sandbox lock
   held by the killed replica to expire; the lock TTL is 60 seconds).
2. **Automatic live-runtime checks** (run when runsc / E2B credentials are present; sections 2 and 3 of this checklist).
3. **Manual checks** (section 4 of this checklist): attachments, artifact tabs and sandbox status in the web app.

The live-environment parts of the first segment (attachments and media input) and the third segment (skills) are in sections 5 and 6: real-model requests with images / PDFs, and the skill library in the web app,
skill change approval and skill scripts. The third segment's dual-replica acceptance `packages/kernel/test/skills/m5-segment3.dual.test.ts` (fake sandbox, runs in `pnpm test`,
about 10 seconds) covers a shared agent's `skill_write` → cross-replica approval → taking effect on another conversation's next run, and `skill_load` copying scripts into the sandbox and running them.

For plugin details see `plugins/sandbox-docker/README.md` and `plugins/sandbox-e2b/README.md`; they are not repeated here.

---

## 0. Read first: where to put the socket proxy

The `sandbox-docker` plugin reaches Docker only through the HAProxy socket proxy in `docker/sandbox-proxy`. **Whoever can reach the proxy can almost control
Docker** (the proxy's request-body check is only a regex backstop).

- **Never publish the proxy on any host address, including `127.0.0.1`**: on Docker Desktop a container on an ordinary bridge network can reach the host loopback through
  `host.docker.internal`; on Linux the bridge gateway address can also reach ports the host listens on.
- In production, put it only on the internal network the kernel is on (`endpoint` set to `tcp://sandbox-proxy:2375`), with no port mapping, and do not attach sandbox containers to that network.
- The dev compose (`docker compose -f docker/compose.dev.yaml --profile sandbox up -d`) publishes it on
  `127.0.0.1:2375` so the local kernel can connect: use that for local development only, and **do not turn on `allowOpenEgress`** (a sandbox with open egress can reach the host loopback, and therefore the proxy).
- Check during acceptance: `docker port <proxy container>` should be empty in the production compose; the `NetworkSettings.Networks` of the sandbox container (`docker inspect cap-<conversation id>`)
  does not include the network the kernel / proxy is on.

## 1. Credentials and environment variables

Credentials live in `~/.capybara-test.env` and are injected into the environment by the outer shell (the test code does not read this file). **Never print or paste the values at any time.**
A value that starts with "替换为" (placeholder text meaning "replace with") counts as unfilled.

| Variable | Required | Description |
|---|---|---|
| `CAPYBARA_TEST_E2B_API_KEY` | Required for E2B | E2B API key (`e2b_…`) |
| `CAPYBARA_TEST_E2B_TEMPLATE` | Required for E2B | Template name or id built from `plugins/sandbox-docker/image/Dockerfile` (see 3.1) |
| `CAPYBARA_TEST_E2B_API_URL` | Optional | Control plane address of self-hosted E2B |
| `CAPYBARA_TEST_E2B_DOMAIN` | Optional | Sandbox domain of self-hosted E2B (default `e2b.app`) |

runsc needs no credentials, only that the Docker daemon has the `runsc` runtime registered (section 2).

## 2. Docker + gVisor (runsc)

### 2.1 Install and register (Linux host; Docker Desktop does not support custom runtimes)

```bash
# Install runsc per https://gvisor.dev/docs/user_guide/install/ (apt repo or download the binary directly)
sudo runsc install                # writes "runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}} into /etc/docker/daemon.json
sudo systemctl restart docker
docker info --format '{{json .Runtimes}}'     # should contain "runsc"
docker run --rm --runtime=runsc hello-world   # should run
```

- To limit workspace disk (`sandbox.limits.diskMb`), `volumeDriver` must be a volume driver that supports the `size` option; the local driver does not limit size.
- arm64 hosts: gVisor has an arm64 build, and the steps are the same.

### 2.2 Automatic checks

```bash
docker build -t capybara-sandbox:latest plugins/sandbox-docker/image
pnpm vitest run plugins/sandbox-docker/test/sandbox-docker.test.ts -t runsc
```

Expected: the case "runsc: lifecycle under gVisor" **passes rather than being skipped** (skipped means `docker info` has no runsc):
the container's `HostConfig.Runtime` is `runsc`, files can be written and read, commands run, files are still there after hibernation / resume, and it is gone after destroy.

### 2.3 Kernel + runsc smoke test (manual)

Start the kernel per section 4, adding `"runtime":"runsc"` to the plugin config:

```bash
export CAPYBARA_PLUGIN_CONFIG='{"object-store-s3":{…},"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375","runtime":"runsc"}}'
```

- [ ] In a conversation, have the agent run `sandbox_bash`: the output of `uname -a; dmesg | head -3` shows gVisor (`Starting gVisor...`);
- [ ] `docker inspect cap-<conversation id> --format '{{.HostConfig.Runtime}}'` is `runsc`;
- [ ] `sandbox_bash` running `sleep 600` with `timeoutSeconds: 2`: returns timedOut after about 2 seconds, and afterwards `ps -eo args` has no `sleep 600`;
- [ ] The attachment, delivery and hibernation / resume flows of section 4 also work under runsc.

### 2.4 linux/amd64 Docker on CI

The local acceptance runs on arm64 Docker Desktop; the amd64 image (Debian packages, the behavior of GNU `timeout` / `pgrep -P` / `pkill -s`)
and the native Linux daemon (networking, `restart`, volumes) need to be confirmed once more on CI:

- [ ] On the CI linux/amd64 runner (native Docker Engine, not Docker Desktop), `pnpm vitest run plugins/sandbox-docker`
      passes entirely (including the socket proxy's real HAProxy cases, "stopped behind the kernel's back", and "commands left behind by a
      crashed kernel replica"), with nothing skipped (except runsc);
- [ ] On the same runner, `pnpm vitest run packages/kernel/test/sandbox/m5-segment2.dual.test.ts` passes (on takeover the `sleep 300`
      left by the predecessor is killed, and the output is `leftover=0`);
- [ ] `docker buildx build --platform linux/amd64 plugins/sandbox-docker/image` succeeds, and `timeout --version` in the image is
      GNU coreutils.

## 3. E2B

### 3.1 Build the template (the same Dockerfile as the Docker plugin)

Build from `plugins/sandbox-docker/image/Dockerfile` with E2B's Template SDK (or the e2b CLI); for the steps see the "Template" section of
`plugins/sandbox-e2b/README.md` (`Template().fromDockerfile(...)`, `cpuCount: 1`, `memoryMB: 2048`,
with a template name such as `capybara-sandbox`). Rebuild the template after changing the Dockerfile. After building, put the template name into `CAPYBARA_TEST_E2B_TEMPLATE`.

### 3.2 Automatic checks

```bash
set -a; . ~/.capybara-test.env; set +a     # only injects the environment; do not cat / echo
pnpm vitest run plugins/sandbox-e2b/test/live
```

Expected: all pass (when the variables are not all filled in, the whole group is skipped and prints `[e2b-live] skipped`). It covers the sandbox user and working directory, file reads and writes,
`/skills` read-only, the egress allowlist, output truncation, kill on timeout, abort, keepalive during long periods with no output, the reboot backstop, same-name replacement, files still there after
pause / resume, and gone after destroy.

**On the first run**, check one by one the 14 "assumptions that can only be confirmed on real E2B" in the header of `plugins/sandbox-e2b/test/live/sandbox-e2b.live.test.ts`
(the `sandbox` user and envd Basic auth, the ownership and permissions of `/opt/capybara` and `/skills`, runuser / setsid / pkill,
root upload, `envdAccessToken`, connect's 200 / 201 and the `memory: false` cold start, envd returning 502 after a pause, long-stream keepalive,
`autoPause`, the allowlist request body and the `*.` wildcard, metadata filtering and pagination of the list endpoint, SendSignal's 404, and the format of pause 409 / DELETE 404),
and record the results in this checklist's execution log. On failure, check these 14 first to find which assumption does not hold.

### 3.3 Kernel + E2B smoke test (manual)

```bash
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-object-store-s3","@capybara-hq/plugin-sandbox-e2b"]'
export CAPYBARA_PLUGIN_CONFIG="{\"object-store-s3\":{…},\"sandbox-e2b\":{\"apiKey\":\"$CAPYBARA_TEST_E2B_API_KEY\",\"template\":\"$CAPYBARA_TEST_E2B_TEMPLATE\"}}"
```

- [ ] The flow of section 4 works; in the E2B console each conversation has one sandbox, with metadata `capybara-sandbox-name=cap-<conversation id>`;
- [ ] After hibernation the console shows the status paused, and on next use it resumes (running), with files still there;
- [ ] With `sandbox.limits.egress` set to `allowlist`, `curl -sI https://pypi.org` works and `curl -sI https://example.com` does not;
      the limitations listed in the README "Egress" section (it only looks at Host / SNI) have been communicated to the deployer;
- [ ] After deleting the conversation (or waiting for the destroy task), the sandbox in the console is deleted.

## 4. Manual checks: run a local kernel + web

```bash
docker compose -f docker/compose.dev.yaml up -d                     # postgres, valkey, seaweedfs (creates the bucket capybara)
docker compose -f docker/compose.dev.yaml --profile sandbox up -d   # socket proxy 127.0.0.1:2375 + two images
export CAPYBARA_PLUGINS='["@capybara-hq/plugin-model-fake","@capybara-hq/plugin-object-store-s3","@capybara-hq/plugin-sandbox-docker"]'
export CAPYBARA_PLUGIN_CONFIG='{"object-store-s3":{"endpoint":"http://localhost:8333","region":"us-east-1","bucket":"capybara","accessKeyId":"capybara","secretAccessKey":"capybara-secret","forcePathStyle":true},"sandbox-docker":{"endpoint":"tcp://127.0.0.1:2375"}}'
export CAPYBARA_PLUGIN_PERMISSIONS__AUTO_APPROVE=true        # for local trials only
export CAPYBARA_AUTH__COOKIE_SECURE=false
export CAPYBARA_SANDBOX__LIMITS__SUSPEND_AFTER_IDLE_MINUTES=1   # to make hibernation easy to observe
pnpm capybara migrate
pnpm capybara start            # kernel :8080
pnpm dev:web                   # in another terminal, web :3000
```

Open `http://localhost:3000` in a browser and create an agent: model `model-fake/fake-1` (or a real model), and add the built-in
`sandbox_bash`, `sandbox_read`, `sandbox_write` and `sandbox_deliver` to its tools.

- [ ] **Attachments**: in a conversation upload a CSV (≤ 20MB) and send `echo:here`; the attachment shows under the message. Then send
      `tool:sandbox_bash:{"command":"ls -l /workspace/attachments && wc -l /workspace/attachments/*.csv"}`:
      the first part of the result is "Sandbox started for this conversation (first use)…", and the file is visible.
- [ ] **Sandbox status**: the "Sandbox" tab on the right shows "Running" and the last-used time; `docker ps` has `cap-<conversation id>`.
- [ ] **Delivery**: `tool:sandbox_bash:{"command":"mkdir -p out && sort /workspace/attachments/*.csv > out/sorted.csv"}`,
      then `tool:sandbox_deliver:{"path":"/workspace/out/sorted.csv"}`; the "Artifacts" tab shows `sorted.csv` (type, size, time),
      the preview shows the first few lines, and "Download" gets the same content (a browser download, with the right file name).
- [ ] **Hibernation / resume**: after 1–2 minutes idle the "Sandbox" tab changes to "Hibernated", and in `docker ps` the container is stopped (`docker ps -a` still has it);
      send `sandbox_read` on `/workspace/out/sorted.csv` again: the content is still there, the result has **no** started / recreated hint,
      and the tab goes back to "Running".
- [ ] **Egress**: under the default `allowlist`, `curl -sI https://pypi.org` works and `curl -sI https://example.com` fails (the egress proxy returns 403 for CONNECT).
- [ ] **Rebuild**: after `docker rm -f cap-<conversation id>`, use the sandbox again: the result carries "Sandbox was recreated; previous files are gone.",
      and the run does not error out or hang.

## 5. Real models: requests with images / PDFs

Credentials likewise live in `~/.capybara-test.env` (`CAPYBARA_TEST_ANTHROPIC_API_KEY`, `CAPYBARA_TEST_OPENAI_API_KEY` +
`CAPYBARA_TEST_OPENAI_MODEL`, `CAPYBARA_TEST_OAICOMPAT_*`), only injected into the environment, never printed.

### 5.1 The media cases of the conformance suite

```bash
set -a; . ~/.capybara-test.env; set +a
pnpm vitest run plugins/anthropic/test/conformance.test.ts plugins/openai/test/conformance.test.ts
# Ark: CAPYBARA_TEST_OAICOMPAT_DIALECT=ark; add CAPYBARA_TEST_OAICOMPAT_VISION=1 when the model supports images
pnpm vitest run plugins/openai-compatible/test/conformance.test.ts
```

- [ ] anthropic's and openai's "user message with image", "user message with PDF document" and "user message with text document"
      pass (not skipped);
- [ ] **The ark dialect's image case** passes (not yet verified against the real API; ark does not accept PDFs, and `documents` is rejected by config validation);
- [ ] When switching to a new model, first check its `vision` / `documents` declarations (anthropic takes them from the Models API; openai / openai-compatible get them from config).

### 5.2 Kernel + web (manual)

Start the kernel and web per section 4, replacing `CAPYBARA_PLUGINS` with a real model plugin (such as `@capybara-hq/plugin-anthropic`) plus `object-store-s3`.

- [ ] Upload a PNG and ask "what color is in the picture": the answer is correct; in the `model_call` event's `request.media` the attachment's `outcome` is `bytes`;
- [ ] Upload a one-page PDF and ask about a word in it: the answer is correct;
- [ ] Switch to a model that does not support images (such as openai-compatible without `vision`) and send an image again: the model receives only the English placeholder `[Attached image "<name>" — this model cannot view images.]` and answers as usual,
      `request.media` is `placeholder_unsupported`, and the provider request has no image bytes;
- [ ] One message with 10 attachments, with the total exceeding `attachments.requestMediaBytes`: the earlier ones are replaced with placeholders, and the request is not rejected by the provider.

## 6. Skills (manual)

Start the kernel and web per section 4 (object storage + `sandbox-docker`). Prepare a zip: `SKILL.md` at the root (frontmatter with `name: fruit-sum` and
`description`) and `run.sh` (`echo fruit-sum ok`).

- [ ] **Skill library**: an admin uploads the zip under "Skills" in the top bar, and the list shows `fruit-sum v1`; on the detail page SKILL.md is shown as plain text; members can view but cannot see upload and delete;
      uploading a package of the same name again gives v2; a package over 50MB or missing `SKILL.md` is rejected with each reason listed.
- [ ] **An agent uses a skill**: edit the agent, tick `fruit-sum` under "Skills", and add `sandbox_bash` to its tools; in a conversation
      `tool:skill_load:{"name":"fruit-sum"}` returns the body, then `tool:sandbox_bash:{"command":"sh /skills/fruit-sum/run.sh"}`
      outputs `fruit-sum ok`; `touch /skills/x` fails (read-only).
- [ ] **A shared agent changes a skill**: add `skill_write` to a shared (org-visible) agent, and have another member ask it in a conversation to write a skill: a tool confirmation appears first (R3),
      after confirming, a "Skill change" appears in the owner's inbox with a per-file diff; before approval `skill_load` in other conversations does not see it, and after approval other conversations' next run
      receives an update reminder and loads the new version; on rejection the originating conversation goes back to the old version.
- [ ] **A private agent changes a skill**: it takes effect directly and does not go to the inbox; the owner can delete skills the agent wrote itself on the agent edit page.

## 7. Execution log

| Date | Run by | Part | Result / notes |
|---|---|---|---|
| 2026-10-21 | automatic | Dual-replica acceptance (runc, arm64 Docker Desktop) | Passed 3/3, about 70 seconds each (takeover and resume about 1.2 seconds, reusing the sandbox waiting for the lock about 60 seconds) |
| | | runsc (section 2) | To run on a Linux host |
| | | CI linux/amd64 Docker (2.4) | To run on CI |
| | | E2B (section 3, including the 14 assumptions) | To run once credentials are in place |
| | | Manual (section 4) | To run |
| 2026-10-21 | automatic | Third-segment dual-replica acceptance (fake sandbox) | Passed 3/3, about 10 seconds each |
| 2026-10-21 | coordinator | Real-model media (5.1: anthropic `claude-haiku-5-5`, openai `gpt-5-nano`) | Images, PDF and text documents passed |
| | | ark dialect images (5.1) | Waiting for credentials |
| | | Kernel + real-model media (5.2) | To run |
| | | Skills (section 6) | To run |
