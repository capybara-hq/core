# Employee co-build

- Date: 2026-10-29, written against `main` at `ae213182`; re-checked 2026-10-30 against `main` at
  `02b9634b` (the Nest kernel refactor, PR #55, merged): file references still hold, and §11.1
  maps the design onto the Nest conventions (`writing-kernel-api`).
- Status: draft for review. Implementation waits for the tool naming spec
  (`2026-10-29-tool-naming-claude-code-design.md`): tool names in this spec are the new ones
  (`Bash`, `Read`, `Skill`, `SkillWrite`, …).
- Related specs: package ecosystem (`2026-10-22-package-ecosystem-design.md`: plugins, catalog,
  import review, org install and upgrade), phase D (`2026-10-27-phase-d-manual-skills-design.md`),
  sub-agents (`2026-10-26-subagents-design.md`).
- Markers: **(decided, 2026-10-29)** is the maintainer's ruling in the discussion of 2026-10-29;
  **(designer's call)** is decided here and may be overturned in review. Items without a marker
  restate current code or AGENTS.md rules.
- Written in English (AGENTS.md "Language").

## Decisions of 2026-10-29

1. **Goal**: every employee can build and grow the platform: an agent knows what it is and how
   it can be extended, helps a person write skills, agent templates, connectors and (later)
   extensions, and submits the result; an administrator approves, helped by a reviewer agent
   **(decided)**.
2. **One submission unit, the plugin** **(decided)**. A submission is a logical bundle whose
   manifest lists what it carries (skills under `skills/`, connector templates, agent templates,
   an extension as a local package or an npm reference). The existing plugin format is that
   bundle; it is extended rather than replaced (§3). A single module (a skill zip, an npm
   extension) can still be submitted alone; it is wrapped as a one-component plugin, so there is
   one submission and review pipeline.
3. **Zip is accepted** for submissions, next to tgz **(decided)**.
4. **Review by risk tier**; extensions are code running in process with full trust, so they always
   need a human, and they are **designed here but not opened in the first phase** **(decided)**.
5. **The reviewer agent is advisory**; a person decides **(decided)** (§6).
6. **Internal hosting is a kernel feature** (the catalog), not a separate service **(decided)**.
7. **The agent-facing self-description is generated from the running platform**, and a CI gate
   keeps its hand-written parts in step with the code **(decided)** (§8).
8. **The platform's agent can do engineering** like Claude Code (sandbox tools, skills,
   sub-agents); what it lacks for extensions is a test loop and a submit path, added in phase 3
   **(decided)** (§9).

Answers of 2026-10-30 to the first draft's open questions:

9. **Org admins approve in phase 1** (`submissions.decide` = admin); a dedicated reviewer role may
   come later **(decided, 2026-10-30)**.
10. **Approve publishes**; installing in the org is a checkbox on the same action
    **(decided, 2026-10-30)**.
11. **Plugin names are deployment-unique**, so an org item is promoted without a rename
    **(decided, 2026-10-30)**.
12. **Submitters never see the review conversation**, only the reviewer's report
    **(decided, 2026-10-30)**.

## 0. Summary

An employee, usually through an agent, builds a plugin: a skill that writes the weekly report, an
agent template for sales follow-ups, a connector template for the internal CRM's OpenAPI. The
agent learns what the platform offers from a live `PlatformInfo` tool and from the builder
skills, writes the files in its sandbox, checks them, and calls `SubmitPlugin`. A person can also
upload a zip in the web app, or submit a skill an agent of theirs already has.

The submission runs deterministic checks (format, limits, a risk report: scripts, tools,
endpoints, widened policies), then a reviewer agent writes an advisory report, then an org
administrator approves or rejects. Approval publishes an **org catalog item**: a catalog item
only that org sees, installed and upgraded with the existing org install, upgrade and rollback.
Code (extensions, npm references) adds the enterprise administrator's approval and is phase 3.

## 1. Where we are

Facts from `main` (`ae213182`):

- **Plugins**: `.capybara-plugin/plugin.json` lists skills, connector templates, agent templates,
  at most one extension and dependencies (name + semver range). Read by `readPluginFiles`
  (`catalog/plugin-package.ts`). Intake is tgz (manual upload, npm, bootstrap) or a git tree;
  **no zip intake for plugins**.
- **Import**: enterprise administrators only (`@EnterpriseAdmin`), prepare -> review -> confirm
  with `reviewHash`, staged 24 h. Files go to the object store under `directory/<itemId>/…`.
- **Catalog**: deployment-wide. `catalog_items.policy` (`allow` / `needs_approval` / `disabled`)
  is per item for the whole deployment; per-org approval is a grant row. Members can request an
  existing item; an org admin installs. **No org-private items.**
- **Skills**: `skills.scope` is `org` or `agent`. `skill_write` writes agent-scope skills (direct
  on private agents, a change request on shared ones). Org skills need `skills.manage` (admin).
  **No path promotes an agent skill to an org skill or a plugin.**
- **Agent templates** come only from plugins; **connector templates** exist only as files in a
  catalog version.
- **Roles**: `guest < member < admin < owner` per org, plus the deployment-level enterprise
  admin. **No teams or groups.**
- **Evals** are bound to agents; full-run replay reuses recorded tool results, so **an eval
  cannot test new skill content today**.
- **Inbox**: a pull inbox for approvers (`tool_approval`, `skill_change`, `catalog_request`). No
  email or push.
- **Sandbox image**: Debian with bash, git, python; **no node, npm, pnpm or `zip`**. Egress
  allowlist includes the npm registry. `sandbox_deliver` is the only way a sandbox file reaches
  the kernel, and only as a download for the person.

## 2. Goals, non-goals, phases

Goals:

- Members submit plugins; org admins approve; approved plugins become installable in that org.
- One pipeline for every entry: agent tool, web upload, an existing agent skill.
- Risk is decided from the content, never from what the submitter claims.
- An agent can find out, from the running platform, what it can build and how.
- Everything an approver needs on one page: the content, the diff to the previous version, the
  deterministic risk report, the reviewer agent's report.

Non-goals:

- Teams or groups (an org is the sharing unit; personal use stays agent-scope skills).
- Email or push notifications (the inbox and the IM channels' existing approval cards suffice).
- A public marketplace for employee plugins outside the deployment.
- Sandboxing extensions out of process (§10.4 notes where it would plug in).

Phases **(designer's call)**:

| Phase | Scope |
|---|---|
| 1 | Org catalog items; submissions of declarative plugins (skills, agent templates, connector templates) from the web (zip / tgz), from `SubmitPlugin` and from an agent skill; deterministic checks and risk report; reviewer agent; inbox; `PlatformInfo` and its gate; the builder plugin (declarative only) |
| 2 | Trial runs for submissions (a candidate agent with the submitted content runs the submission's test prompts, judged); promotion of an org item to the deployment catalog; auto-approval policy; re-checks when the platform version changes; reports from users |
| 3 | Extensions: npm references and local packages in submissions, the enterprise stage, the builder's extension loop (node in the sandbox image, the SDK fake `ctx`, in-sandbox `capybara-plugin pack` / `check`) |

## 3. The bundle

### 3.1 Format

A submission is a plugin (`.capybara-plugin/plugin.json`), unchanged except:

- **Zip intake** for submissions (and, for consistency, the enterprise admin's manual import)
  **(designer's call)**. The zip reader of `skills/package.ts` (yauzl, entry and size caps, zip
  bomb ratio, no symlinks, single wrapper directory stripped) is generalised into
  `packages/zip.ts` and used with the plugin caps (`packages.maxBytes`, 256 MiB unpacked, 5000
  entries). Both containers produce the same file tree for `readPluginFiles`.
- **Dependency sources** (phase 3): a dependency may carry where to get it when the catalog does
  not have it:

  ```json
  { "name": "crm-tools", "version": "^1.2.0",
    "source": { "npm": "@acme/capybara-plugin-crm-tools", "version": "1.2.3",
                "integrity": "sha512-…" } }
  ```

  Resolution stays catalog-first. A `source` is used only when no imported version satisfies the
  range; it is fetched through `packages/kernel/src/net` from `packages.npmRegistry` and verified
  against `integrity`, exactly like a direct npm import. A submission with a sourced dependency
  goes to the enterprise stage (§5.3). SDK schema change (`plugin.v1.schema.json`), changeset.

A minimal skills-only submission:

```text
weekly-report.zip
├── .capybara-plugin/plugin.json   {"schemaVersion":1,"name":"weekly-report","version":"1.0.0",
│                                   "description":"…"}
└── skills/weekly-report/SKILL.md
```

A skills-only tree without `plugin.json` (a single skill zip) is wrapped (§3.2).

### 3.2 Single modules

| Entry | Becomes |
|---|---|
| A skill zip (today's org skill upload format) | a plugin named after the skill, version `1.0.0` (next: the last published version's patch + 1), with that one skill |
| An agent-scope skill of an agent the person owns ("Share with the org" on the skill) | the same, from the skill's current version files |
| A single connector template JSON | a plugin with that one template |
| An npm extension (phase 3) | a plugin depending on it by `source` |

The wrapping is shown in the review ("generated manifest"), so the approver sees exactly what will
be published **(designer's call)**.

### 3.3 Names and versions

- Plugin names stay deployment-unique (the catalog owns names) **(decided, 2026-10-30)**, so an
  org item can later be promoted without a rename. A submission whose name belongs to an item of
  another org or of the deployment catalog is refused (`submission.name_taken`); a name owned by
  this org's item is a new version of it. The check extends the catalog's existing ownership rule
  (`assertPluginNameOwner`, `catalog/catalog-items.ts`) with the owning org, under
  `CatalogItemLock`.
- Versions are exact semver and must be greater than the item's highest published version
  (`submission.version_not_greater`).
- Who may submit new versions of an org item: its original submitter and the org's admins
  **(designer's call)**; the item records `owner_account_id`, transferable by an admin.

## 4. Org catalog items

The catalog gains an owner scope **(designer's call)**:

- `catalog_items.org_id` (nullable; `null` = the deployment catalog as today). Expand-only
  migration.
- An org item is visible and installable only in its org. Its `policy` applies inside that org;
  the org admin sets it (`catalog.decide`). The deployment-wide grant table does not apply.
- Files, versions, content digests, install, upgrade, rollback and uninstall are the existing
  machinery (`PluginInstaller`, `plugin-upgrade.ts`), unchanged.
- Enterprise admins see every org item (read-only list) and may disable one deployment-wide (the
  existing kill switch), and in phase 2 promote one to the deployment catalog (it becomes
  `org_id = null`; the org keeps its installs).
- Deployment settings still apply to what an item can install: `customSkills=deny` blocks
  submissions carrying skills, `customConnectors=deny` those carrying connector templates
  (`submission.disabled_by_setting`).

## 5. Submissions

### 5.1 Model

Table `capybara.submissions` **(designer's call)**:

| Column | |
|---|---|
| `id`, `org_id`, `submitted_by` (account), `via` (`web` / `tool` / `agent_skill`), `conversation_id` (when via tool) | |
| `plugin_name`, `version`, `catalog_item_id` (when a version of an existing org item) | |
| `state` | `checking` -> `in_review` -> `approved` / `rejected`; `withdrawn`; `failed` (checks failed) |
| `stage` | `org` or `deployment` (phase 3) |
| `tier` | `declarative`, `connector`, `code` (§5.3), computed |
| `object_prefix` | the staged files, `kernel/<orgId>/submissions/<id>/` |
| `review` | the `PluginReview` the import already builds, plus the generated-manifest note |
| `review_hash` | as in import confirm |
| `checks` | the deterministic report (§5.2) |
| `reviewer_report` | the reviewer agent's report (§6), or its failure |
| `note` | the submitter's note (≤ 2 000 characters) |
| `decided_by`, `decided_at`, `decision_reason`, `published_version` | |

Submissions do not expire (unlike the 24 h import staging); a withdrawn, rejected or failed
submission's files are deleted after 30 days by an hourly `@LockedCron` job
(`submission-cleanup`), like the import staging cleanup in `catalog/jobs.ts` **(designer's
call)**.

### 5.2 Deterministic checks

Run on queue `cap-kernel-submissions` (§11.1) right after intake; nothing is published until a person
approves. The report has three parts:

1. **Validity**: everything `readPluginFiles` and the import prepare already check (manifest,
   limits, skill parsing, templates, icons, digest, dependency resolution). A failure ends in
   `failed` with the problems listed.
2. **Risk report** (each item with severity `info` / `warn` / `high`):
   - Skills: files besides `SKILL.md` (scripts listed with their interpreters and sizes);
     tools the body or frontmatter names (`Bash`, `Deliver`, `SkillWrite`, `mcp__…`,
     `plugin__…`); size.
   - Agent templates: tools, `toolPolicies` that set `allow` for a tool whose default is `ask`
     (`high`), `maxSteps`, the model.
   - Connector templates: endpoint hosts (and whether they are internal), auth kind, editable
     endpoints, `high` for a host never seen in the org.
   - Dependencies: unresolved, or resolving to items the org has not installed.
   - Extension (phase 3): permissions, hooks, policy hooks, routes, migrations, UI embeds.
3. **Diff** to the previous published version: files added, removed and changed, with the risk
   items that are new.

The checks are code, tested with fixtures like every check in the repository; they never call a
model.

### 5.3 Tiers and who decides

| Tier | Content | Decides | Auto-approval (phase 2) |
|---|---|---|---|
| `declarative` | skills, agent templates | org admin | possible, by org policy (§5.5) |
| `connector` | any connector template | org admin | never |
| `code` | an extension or a sourced dependency (phase 3) | org admin, then enterprise admin | never |

The tier is the highest tier any component reaches.

### 5.4 APIs

| Route | Action (min role) | |
|---|---|---|
| `POST /orgs/:orgId/submissions/uploads` | `submissions.create` (member) | presigned upload, `application/zip` or `application/gzip`, ≤ `packages.maxBytes`, attachment purpose `submission-package` |
| `POST /orgs/:orgId/submissions` `{uploadId \| skillId, note}` | `submissions.create` | intake: unpack, wrap (§3.2), stage, enqueue checks; 202 with the submission |
| `GET /orgs/:orgId/submissions?mine=1&state=` | member: own; admin: all | list |
| `GET /orgs/:orgId/submissions/:id` | submitter or admin | review, checks, reviewer report, diff |
| `POST /orgs/:orgId/submissions/:id/withdraw` | submitter | |
| `POST /orgs/:orgId/submissions/:id/decide` `{decision, reviewHash, reason?, install?}` | `submissions.decide` (admin) | approve publishes the org item version; `install: true` also installs it in the org as the admin (the existing installer) |
| `GET/POST /api/v1/admin/submissions[/:id/decide]` | enterprise admin | phase 3, stage `deployment` |

New org actions `submissions.create` (member) and `submissions.decide` (admin), both
`HUMAN_ONLY`. Errors are registered (`submission.*`). Audit: `submission.created`,
`submission.checked`, `submission.reviewed`, `submission.decided`, `submission.withdrawn`,
`submission.published`.

`decide` re-checks the `reviewHash` and that the org item has not moved on (409
`submission.review_stale`), as import confirm does.

### 5.5 Org settings

`orgs.settings.coBuild` **(designer's call)**:

- `enabled` (default `true` when the deployment allows it; deployment setting `coBuild.enabled`,
  default `true`).
- `reviewerAgentId`: the org agent used as reviewer (§6); unset = no reviewer report.
- `autoApprove` (phase 2): `none` (default) or `declarative-low`: a `declarative` submission whose
  risk report has no `warn` / `high` item and whose reviewer report did not ask for a person is
  approved by the system and audited as such. The reviewer can only block auto-approval, never
  cause it (§6.3).

### 5.6 Where people see it

- Submitter: "My submissions" (state, checks, reviewer report once ready, decision and reason).
- Org admin: the inbox gains `submission` items; the submission page shows content, risk report,
  diff, reviewer report, and approve / reject. Pages are built from design templates
  (`ListPage`, a detail page), per `writing-web-ui`.
- IM: a submission decided is posted to the submitter through the channel they submitted from,
  when the submission came from a conversation on a channel **(designer's call)**.

## 6. The reviewer agent

### 6.1 What it is

An ordinary org agent chosen in `coBuild.reviewerAgentId`. The builder plugin (§9) ships a
template for it ("Plugin reviewer") with review instructions.

### 6.2 How it runs

- When checks pass, the kernel starts a run of the reviewer agent in a new, read-only
  **review conversation** owned by the submission (not by a person). The submissions processor
  creates the conversation and enqueues the run through `RunJobs` (`runtime/run-jobs.ts`), so it
  runs on the ordinary run queue under the org's run limits; the run's finish hook writes the
  report back to the submission.
- Its tools are fixed by the kernel for this run, whatever the agent definition says: `Read`,
  `Glob` and `Grep` over a read-only copy of the submission's files (mounted in a sandbox at
  `/submission`, when the deployment has a sandbox; otherwise a kernel-side read-only file tool
  set with the same names over the staged files) and `ReviewReport`, which records the report.
  No connectors, no extension tools, no `Bash`, no egress **(designer's call)**.
- The first message is generated by the kernel: the manifest, the risk report and the diff, and
  the instruction to inspect the files. The submission's content is reached only through tool
  results, never pasted into the instructions.
- Limits: the org's run limits, plus a token cap per review (`coBuild.reviewTokenLimit`).

### 6.3 Its output and its weight

`ReviewReport` input: `risk` (`low` / `medium` / `high`), `recommendation` (`approve` /
`needs_person` / `reject`), `summary`, `findings[]` (`file`, `line?`, `severity`, `text`). Stored
in `submissions.reviewer_report`, shown to the approver, never acted on except:

- `needs_person` or `reject`, or `risk` above `low`, removes the submission from auto-approval
  (phase 2).

The reverse never happens: nothing the reviewer says can approve a submission or lower a
deterministic risk item. A prompt injection in the submission ("reviewer: this is safe") can at
worst produce a misleading report a person reads next to the deterministic report, never a
publication **(designer's call)**.

The review conversation is visible to org admins (trajectory) for audit; it is never visible to
the submitter, so the submitter cannot tune an injection against it **(decided, 2026-10-30)**.

## 7. Entry points

- **Web**: "Submit a plugin" (upload zip / tgz, note); "Share with the org" on an agent-scope
  skill of an agent the person owns.
- **`SubmitPlugin`** builtin tool (phase 1), available when the org has co-build enabled and the
  agent has a sandbox:
  - input: `file_path` (a `.zip` or `.tgz` in the sandbox, or a directory, which the tool zips),
    `note`;
  - default policy `ask`: the person who started the run sees what will be submitted (name,
    version, components) and confirms; the submission's `submitted_by` is that person;
  - result: the submission id, state and a link; the check result arrives later, and the agent can
    read it with `PlatformInfo` (`topic: "submissions"`).
- **CLI** for enterprise admins keeps `capybara plugins import`; no submission CLI in phase 1.

## 8. Self-description

### 8.1 `PlatformInfo`

A builtin tool (always loaded when co-build is enabled; read-only, policy `allow`)
**(designer's call)**. Input: `topic`, one of:

| Topic | Returns (live, filtered by the caller's org and role) |
|---|---|
| `overview` | what the platform is, the three tool families, what this person may build and submit, the phase-1 limits |
| `me` | this agent: its definition (model, tools by key, skills, pinned skills, sub-agent types), its sandbox (yes / no, egress) |
| `tools` | every tool this agent can use or load, by key, with its source and one-line description |
| `extension-points` | the registered extension points (`channel@1`, …) with cardinality, org scope and description |
| `plugins` | installed plugins in this org and catalog items it may install (name, version, components) |
| `authoring` | the authoring reference: plugin layout, `plugin.json` fields and limits, SKILL.md frontmatter, agent template fields, connector template fields, tool naming, how to submit |
| `submissions` | this person's submissions and their states, check results and decisions |

Never returned: secrets, config values, other people's private agents, other orgs. Output is a
tool result (logged), so replay needs nothing new.

### 8.2 Where the text comes from

- Live parts are read from the registry, the catalog and the agent definition.
- Reference parts are an **agent docs** directory published with the SDK
  (`packages/plugin-sdk/agent-docs/*.md`), so they are versioned with the contracts they
  describe. Field tables in them are generated from the JSON Schemas and the registries
  (`pnpm gen:agent-docs`), prose is written by hand.
- `EXTENSION_POINTS` entries gain a `description` (SDK API change, changeset).

### 8.3 The gate

`check:agent-docs` (full on PRs: cheap, part of `pnpm check`; reads the SDK registries, schemas
and the docs directory) **(designer's call)**:

- rule `agent-docs-stale`: generated sections differ from what `gen:agent-docs` renders;
- rule `agent-docs-missing`: an extension point, a builtin tool, a `plugin.json` field, an agent
  template field or a connector template field without a hand-written entry;
- rule `agent-docs-orphan`: an entry for something that no longer exists.

Proven red first on fixtures, as every check.

## 9. The builder

### 9.1 Phase 1 (declarative)

An official plugin `builder` in `capybara-hq/plugins` **(designer's call)** with:

- skills: `building-skills`, `building-agent-templates`, `building-connector-templates`,
  `submitting` (adapted from the author guides; they call `PlatformInfo` for live facts instead of
  restating them), and `reviewing-plugins` for the reviewer;
- agent templates: "Builder" (sandbox tools, `PlatformInfo`, `SubmitPlugin`, the builder skills
  pinned) and "Plugin reviewer";
- a decision tree in `building-skills`: a skill first; a connector template when an existing
  service has an OpenAPI or MCP endpoint; an extension only when neither can do it (phase 3).

The builder writes files with `Write` / `Edit`, validates them with `PlatformInfo`'s
`authoring` reference and a validation mode of `SubmitPlugin` (`dry_run: true`: runs the
deterministic checks synchronously and returns the report without creating a submission)
**(designer's call)**, then submits.

### 9.2 Phase 3 (extensions)

- Sandbox image (`capybara-hq/plugins`, `sandbox-docker/image`): node 24, `zip`, and
  `@capybara-hq/plugin-tools` preinstalled at the deployment's SDK version.
- `@capybara-hq/plugin-sdk/testing`: a fake `ctx` (scripted model, in-memory `kv` and storage
  with TTLs, recorded tool registrations and hook calls), pure, so the SDK keeps depending on no
  other `@capybara-hq/*` package. The builder runs an extension's tests with vitest in the
  sandbox, without PG or Redis.
- The builder runs `capybara-plugin pack` and `check` in the sandbox until both pass, then
  `SubmitPlugin` with the tgz.
- Review stage `deployment`: the enterprise admin sees the org admin's decision, the full risk
  report (permissions, hooks, migrations) and the reviewer report, and deploys the extension with
  the existing permission approval.

## 10. Security

1. **Content decides the tier** (§5.3), computed by code; the submitter's note and manifest
   claims don't.
2. **Skills are prompts**: a skill can instruct another person's agent to misuse its tools. The
   risk report lists every tool a skill names, and installing a skill never changes an agent's
   tools or policies; an agent template that widens a policy is `high`.
3. **The reviewer agent is untrusted output** (§6.3): read-only tools, no egress, cannot approve,
   its conversation hidden from the submitter.
4. **Extensions** (phase 3) remain full trust once deployed; two human approvals and the existing
   permission approval are the gate. Running employee extensions out of process would change this
   section, not the pipeline: the submission tier `code` is where such a runtime would be chosen.
5. **Zip and tgz intake** reuse the hardened readers; every archive is malicious input.
6. **Provenance**: every published version records the submission, submitter, approver and the
   content digest; uninstall and rollback are the existing ones.

## 11. Migrations, SDK, config, docs

- Kernel migrations: `catalog_items.org_id` + index; `catalog_items.owner_account_id`;
  `submissions`. Expand-only.
- SDK: dependency `source` (phase 3), `EXTENSION_POINTS[].description`, `agent-docs/`, the
  `testing` subpath (phase 3); JSON Schemas regenerated; API report; changesets.
- Config: `coBuild.enabled`, `coBuild.reviewTokenLimit` (deployment); org setting `coBuild`.
  `docs/config.md` regenerated.
- Skills: `writing-plugins` (submissions, org items), `writing-tools` (`PlatformInfo`,
  `SubmitPlugin`), `writing-kernel-api` (new actions); AGENTS.md "Catalog and marketplaces".

### 11.1 Kernel wiring (Nest conventions)

How the pieces map onto the kernel as it is after the Nest refactor (`writing-kernel-api`, the
`kc-*` rules of `check:kernel-conventions`):

| Piece | Where and how |
|---|---|
| `SubmissionsModule` | new domain directory `src/submissions/`; imports `CatalogModule` (catalog writes, `CatalogItemLock`, `PluginInstaller`), `SkillsModule` (skill share), `OrgsModule` (`OrgLock`), `AttachmentsModule` and storage, `RunJobsModule` (reviewer runs), `InboxModule` |
| `SubmissionsService` | `@Injectable`, `@Inject` on every constructor parameter; writes are `@Transactional()` methods that call `orgLock.lockAndAuthorize(orgId, actor, "submissions.create" \| "submissions.decide")` first, so the role is re-read inside the transaction; audit rows in the same transaction |
| Publishing on approve | in the decide transaction: `CatalogItemLock`, the name owner check, `writeCatalogVersion` (`catalog/catalog-items.ts`), then, with `install: true`, `PluginInstaller` under the org lock; the stale check compares `reviewHash` and the item's latest version inside the lock |
| Intake and checks | the intake transaction writes the row in `checking` and enqueues the check job with `afterCommit` (no enqueue inside a transaction: `kc-side-effect-in-tx`); job ids are the submission id (no `:`) |
| Queue `cap-kernel-submissions` | `QueueModule.registerQueue`; one consumer `SubmissionsProcessor` (`@Processor`, every job inside `runJob`), provided only under `WorkerModule` (`kc-worker-only`); it runs the checks, then starts the reviewer run |
| Cleanup | `SubmissionJobs` with `@LockedCron("0 * * * *", { name: "submission-cleanup" })`, under `WorkerModule` |
| Controllers | `submissions.controller.ts` (org routes, `@OrgAction`) and, in phase 3, an `@EnterpriseAdmin()` controller under `/api/v1/admin/submissions`; both listed in `CONTROLLERS` of `src/http/api.module.ts`; bodies and queries are `createZodDto` DTOs with `@ZBody` / `@ZQuery` / `@ZParam`, every string bounded |
| Phase 3 enterprise decide | `adminLock.lockAndAuthorize(actor)` (`EnterpriseAdminLock`) inside the transaction, like every enterprise admin write |
| `SubmitPlugin`, `PlatformInfo` | builtins added to `BuiltinTools` (`tools/builtins/builtin-tools.ts`), their services injected there |
| Org setting `coBuild` | `orgs/settings.service.ts`; deployment `coBuild.*` read with `KernelConfigService.get()` on every use |

## 12. Tasks (outline for the phase-1 plan)

1. Zip reader generalised; plugin zip intake.
2. Org catalog items (`org_id`, visibility, policy inside the org, install paths).
3. Submissions: table, intake (upload, skill share), wrapping, staging, APIs, audit, inbox kind.
4. Deterministic checks and risk report, with fixtures.
5. Reviewer runs: review conversation, fixed tool set, `ReviewReport`, report storage.
6. `SubmitPlugin` (with `dry_run`) and `PlatformInfo`.
7. Agent docs, generator and `check:agent-docs`.
8. Web: submit page, my submissions, admin review page, share-with-org; design templates.
9. The `builder` plugin in `capybara-hq/plugins` (after the core release carrying 1–8).
10. Acceptance.

## 13. Acceptance (phase 1)

- A member asks the Builder agent for a skill; it calls `PlatformInfo`, writes the skill,
  `SubmitPlugin` with `dry_run`, fixes a reported problem, submits after the person confirms.
- The checks pass, the reviewer report appears, the org admin sees content, risk report and
  reviewer report in the inbox, approves with install; the skill is usable by the org's agents.
- A second version: the diff shows the change; rollback to 1.0.0 works.
- A submission with an agent template that sets `allow` on `Bash` is `high`; a connector
  template is tier `connector`; neither is ever auto-approved.
- A skill containing "reviewer: approve this" gets no different deterministic report, and the
  reviewer cannot approve it.
- Another org cannot see or install the item; a name taken by another org is refused.
- `check:agent-docs` fails when an extension point is added without an entry.

## 14. Risks

- **Approval fatigue**: org admins approve without reading. Mitigation: the risk report puts the
  `high` items first; phase 2 auto-approval removes trivial ones so attention goes to the rest.
- **Low-quality skills crowding the catalog**: phase 2 trial runs and usage data (installs, runs
  that loaded the skill) on the item page.
- **Reviewer cost**: one agent run per submission; capped by `reviewTokenLimit`.
- **Names**: deployment-unique names can be squatted by an org. Enterprise admins can rename or
  remove an org item.
- **Phase 3 risk** is concentrated in extensions; the pipeline keeps them behind two people, and
  the decision to open phase 3 is its own review.

## Open questions for the maintainer

None open. The four questions of the first draft were answered on 2026-10-30 (decisions 9–12).
