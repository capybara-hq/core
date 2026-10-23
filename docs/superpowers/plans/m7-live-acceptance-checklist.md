# M7 release gate checklist (first 0.1.0 release)

M7's automatic acceptance (hooks, gateway sharing, webhook inbound, compose files, release tooling) runs in
`pnpm test` and CI. This checklist is the **manual release gate** (decision E9): the repo owner runs it
after the M7 PR is merged and before 0.1.0 is announced. It needs real accounts (npm, GitHub, Slack or
Lark), so no agent can run it.

How the first publish works (P-16): it happens **only** by running the `Release` workflow manually
(`workflow_dispatch`) on `main`. Pushes to `main` never publish 0.1.0:

- the `publish` job runs `pnpm release --auto`, which refuses while none of our packages is on npm yet;
- the image planner builds nothing until then;
- the `version-pr` job only opens or updates a "Version Packages" PR, and only when `.changeset/` has
  pending changesets. M7 deletes them all (F3), so merging M7 opens nothing.

Do not merge a Version Packages PR before the first manual run if you want 0.1.0 to be the first release
(see "The first release" in [docs/deploy/release.md](../../deploy/release.md)).

Record the date, environment and result of every step in "Results" at the end. Never paste tokens or
passwords into this file, an issue or a chat.

## 0. Release prerequisites

Complete these before dispatching the release. Secret and variable names are the ones
`.github/workflows/release.yml` reads.

- [ ] **Repository visibility.** `capybara-hq/core` is public, **or** the ghcr and npm visibility
  decisions are made and written down.
  - npm provenance needs a public source repository whose URL matches each package's `repository.url`
    (`check:release-metadata` enforces the URL).
  - The image builds use the free `ubuntu-24.04-arm` runners, which exist only for public repositories.
    A private repository needs paid larger arm runners or a switch back to QEMU.
- [ ] **npm scope and rights.** The `@capybara-hq` org exists on npm and the publishing user has publish
  rights: `npm org ls capybara-hq` and `npm access list packages @capybara-hq` work for that account.
- [ ] **npm credential.** Repository secret **`NPM_TOKEN`**: a granular access token with read and write
  on the `@capybara-hq` packages that can publish without interactive 2FA.
  - release.yml supports both ways. `NPM_TOKEN` is **required for the first publish**, because npm
    trusted publishing is configured per existing package.
  - Trusted publishing (OIDC; repository `capybara-hq/core`, workflow `release.yml`) can replace it
    later: when `NPM_TOKEN` is unset the workflow logs "relying on npm trusted publishing" and npm >= 11.5
    uses the OIDC token (the job has `id-token: write`). This path is untested live.
- [ ] **`RELEASE_PR_TOKEN` (optional, recommended).** Repository secret: a fine-grained PAT or GitHub App
  token with Contents and Pull requests read/write on `capybara-hq/core`.
  - With it, Version Packages PRs are opened and updated with that token, so `ci.yml` runs on them and
    `ci-ok` reports.
  - Without it the workflow falls back to `GITHUB_TOKEN`, whose pushes do not trigger `ci.yml`: `ci-ok`
    never reports on the Version Packages PR, and the workflow logs a notice. Trigger CI by hand (close
    and reopen the PR, or push an empty commit to it). Not needed for the first release.
- [ ] **Actions setting.** Settings → Actions → General → "Allow GitHub Actions to create and approve
  pull requests" is enabled (needed by `changesets/action` when `RELEASE_PR_TOKEN` is not set). Also
  check Workflow permissions: an org policy that caps tokens at read blocks the image push (`packages:
  write`); the read-only default is fine because each job declares its own permissions.
- [ ] **ghcr policy and linking.**
  - Org → Settings → Packages → Package creation allows **public** container packages.
  - No existing package in the org is named `capybara-api`, `capybara-worker`, `capybara-gateway` or
    `capybara-web` while linked to another repository (the `GITHUB_TOKEN` push would get 403).
  - After the first real run creates the four packages (they start private): set each to **Public** and
    check under "Manage Actions access" that `capybara-hq/core` has **Write** (the OCI source label
    normally links it). This step is repeated in step 2.
- [ ] **`protect-main` ruleset.** A ruleset named `protect-main` is active on `main`: pull request
  required, status checks `ci-ok` and `issue-linked` required. The branch **`cla-signatures` is
  excluded** and no ruleset covers it (the CLA workflow pushes signatures there).
- [ ] **CLA.** Legal review of [CLA.md](../../../CLA.md) is done, and the draft banner is removed, before
  any external PR is merged (CONTRIBUTING.md: external PRs are not merged while the CLA is a draft).

## 1. CLA bot (unverified in M7)

The CLA workflow (`.github/workflows/cla.yml`) was never run against a fork. Verify:

- [ ] Open a PR from a fork. Expect: the bot comments with signing instructions and the `CLA` status is
  red.
- [ ] Comment `I have read the CLA Document and I hereby sign the CLA`. Expect: the status turns green
  (the workflow re-runs the check; `actions: write` is what allows it), and the signature appears in
  `signatures/v1/cla.json` on the `cla-signatures` branch.
- [ ] Bot PRs are exempt: a Dependabot PR, a `github-actions[bot]` PR and a `changeset-bot` PR get no
  CLA comment (allowlist in cla.yml).
- [ ] Know the limits: the upstream action repo (contributor-assistant) is **archived**, so no upstream
  fixes are coming. Fixes mean pinning a fork or replacing the action.
- [ ] `cla-signatures` is not covered by any ruleset (Settings → Rules): if it is, the seed or signature
  push fails.

## 2. Release (the first publish)

Prerequisite: section 0 complete, M7 merged to `main`, `main` CI green.

- [ ] **Dry run.** Actions → Release → Run workflow on `main` with `dry_run: true`. Expect: packages are
  packed, `npm publish --dry-run` succeeds, all four images build for both architectures (8 jobs) and
  nothing is pushed. Fix anything red; a dry run may also run from another ref.
- [ ] **Real run.** Run the workflow on `main` with `dry_run: false` (a real manual publish is refused
  from any other ref). Expect: green run, the `npm-plugin-packages` artifact is attached.
- [ ] **npm.** `npm view @capybara-hq/plugin-sdk version` prints `0.1.0`; the same for `kernel`,
  `testing` and every plugin except the `example-*` ones. Each package page shows the provenance badge.
- [ ] **Images.** `docker buildx imagetools inspect ghcr.io/capybara-hq/capybara-api:0.1.0` lists
  `linux/amd64` and `linux/arm64`; repeat for `capybara-worker`, `capybara-gateway`, `capybara-web`. The
  `latest` tag exists on each.
- [ ] **Package settings.** Each of the four ghcr packages is **Public** and "Manage Actions access"
  lists `capybara-hq/core` with Write.
- [ ] **Tag and release.** The tag `v0.1.0` and its GitHub release exist.
- [ ] **Idempotence.** A later push to `main` publishes and builds nothing.

## 3. Clean host: compose up (start the timer)

Prerequisite: section 2 done. Use a clean amd64 Linux host (Docker Compose v2.23 or newer) and repeat on
an arm64 machine. Do not use a repository checkout: copy only `docker/compose.yaml` and
`docker/.env.example`.

- [ ] Copy both files, `cp .env.example .env`, fill in the five required values (see
  [docs/deploy/README.md](../../deploy/README.md#first-start)), run `docker compose up -d`, and
  **start the timer**.
- [ ] Expect: images pull without login; `docker compose ps -a` shows `init` exited 0 and every other
  service healthy; `http://localhost:3000` shows the setup page.

## 4. Web login and installing a plugin from npm

- [ ] Create the enterprise admin on the setup page (with `CAPYBARA_SETUP_TOKEN`) and log in.
- [ ] Admin → Plugins → Install plugin: enter `@capybara-hq/plugin-slack` (or `plugin-lark`) from npm,
  review the permissions, install, approve and enable it. Fill in the deployment config.
- [ ] Expect: the plugin shows enabled with no restart, and its config is accepted.

## 5. A real Slack or Lark connection (the gate)

Creating the app on the platform side is described in `plugins/slack/README.md` and
`plugins/lark/README.md`; that time is excluded from the target.

- [ ] Create a channel connection in long-connection mode (the default), @mention the bot in the IM.
- [ ] Expect: the bot replies. Record the time since the timer in step 3. **Target: 5 minutes or less**
  (excluding platform-side app creation).

## 6. Optional: webhook mode

Prerequisite: a public HTTPS ingress and `channels.webhookBaseUrl` set.

- [ ] Switch the connection to webhook inbound (Channels → connection → Overview → Inbound mode) and
  exchange one more message. Expect: the reply arrives; switching back to long connection works.

## 7. Optional: sandbox profile

Prerequisite: **a checkout of the repository.** Only four images are published; the two sandbox images
(`capybara-sandbox`, `capybara-sandbox-egress`) are built locally from `plugins/sandbox-docker`, so
`docker compose --profile sandbox` does not work from the two copied files of step 3 (P-10).

- [ ] From a checkout's `docker/` directory run `docker compose --profile sandbox up -d`, then install
  and enable the plugin from npm:
  `docker compose exec api node /app/bin/capybara.mjs plugins install npm:@capybara-hq/plugin-sandbox-docker --yes`,
  `... plugins approve sandbox-docker --yes`, `... plugins enable sandbox-docker`. Set the plugin's
  `endpoint` to `tcp://sandbox-proxy:2375`.
- [ ] Run `sandbox_bash` (the builtin sandbox command tool; there is no `sandbox_exec`) once from an agent that has it, for example `echo ok`. Expect: output
  returned; `sandbox-proxy` publishes no host port.

## 8. Record results

- [ ] Fill in "Results". Failures go into the known issues of
  [docs/releases/0.1.0.md](../../releases/0.1.0.md) and into GitHub issues.
- [ ] When everything passes, mark the M7 "unverified" items that were verified (CLA bot, first real
  release workflow run, trusted publishing if tried) in the release notes.

## Results

| Step | Date | Environment | Result / notes |
|---|---|---|---|
| 0 Prerequisites | | | |
| 1 CLA bot | | | |
| 2 Release | | | |
| 3 Compose up (amd64 / arm64) | | | |
| 4 Plugin from npm | | | |
| 5 Real connection (minutes) | | | |
| 6 Webhook (optional) | | | |
| 7 Sandbox (optional) | | | |
