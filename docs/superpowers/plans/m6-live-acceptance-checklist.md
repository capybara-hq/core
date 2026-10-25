# M6 live environment acceptance checklist (judge model, npm, enterprise catalog, Nacos, multi-host plugin sync, a real app bundle)

> Written before the 2026-10-24 terminology rename: read "app bundle" as **plugin**, "plugin" (the
> in-process code and its tgz) as **extension** / **extension package**, "enterprise directory" as
> **catalog**, and "catalog" (an index.json source) as **marketplace**. Commands, config keys and page
> names below use the current names. The package formats it exercises (app bundles, `index.json`) were
> replaced before 0.1.0 by `.capybara-plugin/plugin.json` and `marketplace.json`
> (`.agents/skills/writing-plugins`); run its package steps with repacked plugins.

M6 acceptance has two parts:

1. **Automatic acceptance** (runs in `pnpm test`, with a fake model, a fake npm registry, a fake catalog server and dual replicas):
   the first segment (evals), the second segment (plugin lifecycle and admin console) and the third segment (enterprise directory) each have an acceptance test, see Tasks 9, 21 and 29 of the plan
   `docs/superpowers/plans/2026-10-22-m6-eval-admin.md`.
2. **Live environment acceptance** (this checklist, to be run once the conditions are in place): a real judge model, public and private npm, a really hosted enterprise catalog,
   the Nacos source, multiple hosts, a smoke test after installing all official plugins from tgz, and one real app bundle.

For details of the extension package format, lifecycle and catalog, see `skills/writing-extensions`, `skills/writing-plugins` and `skills/replay-evals`; they are not repeated here.

The live environment items left over from M4 / M5 (Slack / Lark, E2B, runsc and so on) are still governed by their own checklists
(`m4-live-acceptance-checklist.md`, `m5-live-acceptance-checklist.md`); section 6 of this checklist only requires
running the smoke tests in those two checklists once "after switching to tgz installs", without repeating the steps.

---

## 1. Credentials and environment variables

Credentials live in `~/.capybara-test.env` and are injected into the environment by the outer shell (the test code does not read this file).
**Never print or paste the values at any time**, and never write them into this checklist, logs or commits. A value that starts with "替换为" (placeholder text meaning "replace with") counts as unfilled.

The variable names in the table below are conventions drafted for manual acceptance; neither the code nor the tests read them currently. If the run is later written as an automated test, the names the test actually uses win.

| Variable | Required | Description |
|---|---|---|
| `CAPYBARA_TEST_JUDGE_BASE_URL` / `_API_KEY` / `_MODEL` | Required for section 2 | The real model used as the judge (any installed provider plugin; reuse a model verified in `capybara-live-api-tests`) |
| `CAPYBARA_TEST_NPM_TOKEN` | Required for the private registry in section 3 | A read-only token for the private npm registry |
| `CAPYBARA_TEST_NPM_REGISTRY` | Required for the private registry in section 3 | Private registry address |
| `CAPYBARA_TEST_CATALOG_URL` / `_TOKEN` | Required for section 4 | Address and access token of the really hosted enterprise catalog `index.json` |
| `CAPYBARA_TEST_NACOS_*` | Required for section 5 | Nacos address, namespace, dataId and credentials |
| `CAPYBARA_TEST_HOSTS` | Required for section 7 | The list of hosts taking part in multi-host acceptance |

Public npm needs no credentials. Each section begins with its "Prerequisites"; if they are not met, skip that section and record the reason at the end.

## General preparation

- [ ] Prerequisite: PG and Valkey are available locally or in the test environment; an enterprise admin has been created with `capybara admin create` and can sign in to the web admin console.
- [ ] Prerequisite: the core image or local build contains only the kernel plus `openai-compatible` and `object-store-s3`; every other official plugin is installed through section 6.
- [ ] Step: `pnpm pack-plugins` builds the tgz of all official plugins (note the output directory).
- [ ] Expected: one tgz per plugin, and the validation stage of `capybara extensions install <tgz>` reports no errors.

## 2. A real model as the judge

Prerequisites: a real model provider is installed and enabled; the org has an agent and at least 3 real conversations (including tool calls and one approval);
the admin console's "Models" page has mapped the purpose `eval` to the judge model.

- [ ] Step: on the "Evals" page, create an eval set from these conversations; open one of the cases and check that the snapshot has events, the agent version and the tool definitions.
  Expected: the case opens, and the page leaks nothing beyond the conversation (a trajectory that does not belong to the person / org returns 404).
- [ ] Step: start a step replay on the eval set (swapping in a different model); before the run the page shows the estimated request count.
  Expected: the run is enqueued and executes within the org's concurrency cap, and the result has the structural diff and each step's tokens / cost.
- [ ] Step: start a full-run replay.
  Expected: tool calls replay only the recorded results, and no real tool is executed (no side effects on external systems, no new commands in the sandbox).
- [ ] Step: turn on the LLM judge for the run, with the judge purpose `eval`.
  Expected: each case gets the judge's pass / fail and reason; the judge calls count toward the `eval` purpose and the org's usage.
- [ ] Step: set the run's token cap very small and run again.
  Expected: the run stops once the cap is reached, the status shows it stopped because of the cap, and the results of completed cases are kept.
- [ ] Step: in the trajectory viewer, manually label a case pass / fail.
  Expected: the label is saved and counted as a human result in the run summary; the audit has a `trajectory.viewed` record.

## 3. Public and private npm

Prerequisites: the deployment can reach public npm; section 3.2 needs a private registry and a token, and the registry holds a test plugin that was packed to the `pnpm pack-plugin` conventions and published.

### 3.1 Public npm

- [ ] Step: on the admin console "Extensions" page, install by package name an official plugin published to public npm (or `capybara extensions install <package name>`).
  Expected: an install confirmation page (permission manifest) is shown; after approval the package is downloaded, the sha512 / single-file ESM constraints are validated, and the status becomes installed; no npm install and no install scripts run.
- [ ] Step: install a non-compliant package (with a native module or a non-literal dynamic import).
  Expected: the install is rejected with an error explaining why, and PG has no half-installed state.

### 3.2 Private npm

- [ ] Step: set `packages.npmRegistry` and `packages.npmToken` (through environment variables) and install a plugin from the private registry by package name.
  Expected: the install succeeds; the token is sent only to the registry's origin and does not appear in logs, audit or the UI.
- [ ] Step: retry with a wrong token.
  Expected: the install fails with an actionable hint (authentication failed) and does not leak the token.
- [ ] Step: leave `npmToken` unset, change the registry to the private address in the admin console, and retry.
  Expected: fields whose config comes from environment variables / a file show as read-only in the UI with their source marked.

## 4. A really hosted enterprise catalog and offline mode

Prerequisites: a really hosted enterprise catalog `index.json` (HTTPS, needs a token) containing at least one plugin, one connector template, one skill and one app;
if there is a mirror address, prepare it too.

- [ ] Step: under "Enterprise directory → Sources", add the enterprise catalog (address + token).
  Expected: the fetch succeeds and the entries appear in the directory; the token is not echoed in the UI or logs; the size is within `marketplaces.maxIndexBytes`.
- [ ] Step: refresh manually, then wait one `marketplaces.refreshIntervalMinutes` period.
  Expected: the manual refresh takes effect immediately; the periodic refresh is run by only one replica (with multiple replicas the log shows no duplicates).
- [ ] Step: make the primary address unavailable (temporarily break it) and configure `mirrors`.
  Expected: the mirrors are tried in order and one succeeds; when all fail, the previous entries are kept and the source shows the most recent error.
- [ ] Step: import a plugin entry from the catalog.
  Expected: the downloaded package is verified against the sha512 in the catalog; after tampering with the integrity the import is rejected.
- [ ] Step: set `marketplaces.official.enabled = false` (offline mode) and disconnect from the internet.
  Expected: the official catalog is never fetched; enterprise catalogs and manual upload still work; already imported entries install as usual.
- [ ] Step: go back online and turn the official catalog on again.
  Expected: the official catalog address is now a placeholder address (M7 swaps in the real one), and a failed fetch shows only in the source status and does not affect kernel startup.

## 5. Read-only display of the Nacos source

Prerequisites: the kernel started with `CAPYBARA_CONFIG_SOURCE=nacos`, the deployment config of some plugin in Nacos contains at least one field (for example some `slack` field);
PG also stores some other fields for the same plugin.

- [ ] Step: open that plugin's config page in the admin console.
  Expected: fields present in Nacos show as read-only marked "Source: Nacos"; fields present only in PG are editable and marked "Source: Admin console".
- [ ] Step: change that field in Nacos and publish.
  Expected: a hot-reloadable field (`hot`) takes effect, a non-hot field prompts for a restart; the value shown in the UI changes accordingly.
- [ ] Step: set an environment variable of the same name.
  Expected: the environment variable has the highest precedence, the field is marked with the source "Environment variable", and it is still read-only.
- [ ] Step: write an invalid value in Nacos.
  Expected: that plugin goes into pending (reason: config), the kernel keeps running and other plugins are unaffected; it recovers after the value is fixed.

## 6. Run the M4 / M5 smoke tests after installing all official plugins from tgz

Prerequisites: a brand-new deployment whose core image contains only `openai-compatible` and `object-store-s3`; the credentials of section 1 are in place per the M4 / M5 checklists.

- [ ] Step: with `capybara extensions install <tgz>` or a web upload, install in turn `anthropic`, `openai`, `model-fake`, `connector-mcp`,
  `connector-openapi`, `todo`, `example-board`, `example-counter`, `slack`, `lark`, `sandbox-docker`, `sandbox-e2b`.
  Expected: each goes through the install confirmation page and an enterprise admin approves its permissions; sandbox / storage plugins are marked as sensitive items on the confirmation page; the kernel is never restarted.
- [ ] Step: for each plugin do "disable → enable → upgrade to a new version of the same package → uninstall".
  Expected: in-flight tool calls finish or are aborted after the timeout; dependents (for example features that depend on `sandbox@1`) receive the disable and reload after enable; after uninstall all registrations are revoked.
- [ ] Step: run the Slack / Lark live-platform checks per sections 2–5 of `m4-live-acceptance-checklist.md`.
  Expected: the same results as when loaded from the source directory.
- [ ] Step: run the sandbox (runsc / E2B), attachment and media, and skill checks per the sections of `m5-live-acceptance-checklist.md`.
  Expected: the same results as when loaded from the source directory.
- [ ] Step: right after installing, enable the same plugin in another org.
  Expected: different orgs' config and data are invisible to each other.

## 7. Plugin sync and convergence across multiple hosts

Prerequisites: at least two hosts each running a kernel replica (the same PG and Valkey, object storage optional); the two hosts' local plugin directories are independent.

- [ ] Step: on host A's web app, install a plugin and enable it.
  Expected: host B syncs the package and loads it within a few seconds, both sides' admin console "load status" shows loaded, and the versions match.
- [ ] Step: repeat the above without configuring object storage (packages stored in PG).
  Expected: it converges the same way.
- [ ] Step: upgrade a plugin, stop host B's kernel during the upgrade, and start B again after the upgrade completes.
  Expected: on startup B loads the new version according to PG's desired state; in-flight calls on A are not lost during the upgrade.
- [ ] Step: clear B's local plugin directory and restart.
  Expected: B fetches the package from PG / object storage again and loads it, with no manual intervention.
- [ ] Step: disable the plugin on A while an in-progress conversation on B calls its tool.
  Expected: B's in-flight call is aborted after it finishes or times out, after which the tool returns a "plugin disabled" style error; the conversation itself does not crash.
- [ ] Step: click "Upgrade" on the same plugin on A and B at the same time.
  Expected: the migration is run by only one replica holding the lock, with no duplicate migration or half upgrade; in the end both sides' versions match.
- [ ] Step: stop Valkey's pub/sub (or disconnect one host's broadcast connection) for about 1 minute and then restore it.
  Expected: the periodic maintenance task is the backstop, and the hosts converge to the desired state after recovery.

## 8. End-to-end install and uninstall of a real app bundle

Prerequisites: a real app bundle, for example a Feishu app: `app.yaml` contains the `lark` plugin, a document connector template (for example a Feishu docs MCP / OpenAPI connector template) and a skill;
`lock` has the npm name, range, exact version and sha512; and the platform-side app for `lark` has been created per `plugins/lark/README.md`.

- [ ] Step: an enterprise admin imports the plugin (app bundle) under "Catalog" from a file / npm / marketplace (preview first, then confirm).
  Expected: the preview lists all components, the permission summary and the locked versions; after confirming, the plugin is installed as a package, and the connector template and skill enter the directory;
  if any component fails validation the whole import is not persisted.
- [ ] Step: set a policy for each entry (allow / needs approval / disabled); set one of them to "needs approval".
  Expected: members can only request an entry that "needs approval", and it can be installed only after an admin approves.
- [ ] Step: an org admin installs this app in the org, filling in `lark`'s org-level config and the connector's editable endpoint.
  Expected: the plugin (enabled in the org), connector and org skill are installed in one go; the component ledger records whether each component was brought in by this app.
- [ ] Step: end-to-end use: ask the bot a question in Feishu and have the agent read a Feishu document and organize it per the skill.
  Expected: the agent sees the document connector's tools, the tool policies match `defaultToolPolicies`, and write operations trigger a Feishu card approval, after which it continues.
- [ ] Step: install another app that shares a component with it (for example the same skill or connector template), then uninstall the first app.
  Expected: shared components are kept and exclusive ones are removed; the plugin is disabled in the org but the deployment-level install remains (other orgs are not affected).
- [ ] Step: uninstall the second app.
  Expected: all components are removed and the ledger is emptied, existing conversations keep their history; it can be installed again with a result identical to the first time.
- [ ] Step: try to upgrade the app (a new version was published in the directory).
  Expected: M6 does not support app upgrades, and the UI explains it can only be uninstalled and reinstalled.

## 9. Record

- [ ] After each section is run, record the date, environment and conclusion here; write failed items up as issues, and never paste any credentials or tokens into this checklist.
- [ ] After everything passes, mark the deferred "live environment acceptance" item in the roadmap's M6 row as done.
