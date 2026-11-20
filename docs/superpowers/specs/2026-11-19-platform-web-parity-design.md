# Platform: what a person can do on the web, their agent can do

Status: design, open questions decided by the maintainer (2026-11-20); awaiting review.

Scope: the kernel's `Platform` tool (`packages/kernel/src/platform`), the approval flow it uses, the
web approval card, `check:platform-ops` and the parity test. No SDK contract changes, no plugin
changes.

Builds on the Platform tool spec (`2026-11-07-platform-tool-design.md`, phases 1 and 2). Where this
document differs from it, this document wins.

## 1. Intent

The maintainer's direction (2026-11-19, after argus conversation 45a32b07):

> 我能在网页干什么，智能体就会对等的。例外四类里可以去掉文件上传。不是所有的组织管理员都是技术
> 人员，我希望连系统配置这件事情，智能体都可以帮他。

Examples the maintainer gave:

- A super admin asks the agent to look in the marketplace for a plugin, then **guide the install
  and the configuration**.
- An org admin asks the agent to set the org's vision model and memory model.
- The agent sets an image it generated as its own avatar (the conversation that started this:
  `agents.update-profile` takes only preset animals, because uploads are excluded).

Phase 2 already gave the tool 235 operations in 20 domains. What is left is not a list of missing
pages. It is a short list of **mechanisms** the tool lacks, each blocking a whole family of routes.

## 2. What blocks parity today

`PLATFORM_EXCLUSIONS` has 170 routes:

| Category | Routes | What they are |
|---|---|---|
| `human-only` | 65 | login and session, tokens, approvals and request decisions, trust decisions (extension permissions, import confirms), members and roles, device pairing, a person's own permission settings |
| `secret` | 24 | anything whose body or response carries a secret: extension deployment and org config, connector create / credentials / OAuth connect, channel create, catalog install with config |
| `transport` | 52 | byte streams, SSE, embeds, health, public share pages, **and 9 uploads** |
| `internal` | 29 | web-only helpers (navigation, form schemas, the deprecated queue), starting conversations and sending messages |

Each family blocks a different part of the maintainer's examples:

1. **Secrets.** Most system configuration needs one: a model provider's API key, an OAuth client
   secret, a channel's app secret, a connector token. Today the tool refuses the whole write and
   points to the web. `plugins.set-enabled` fails with `plugin.needs_input`. "Guide the
   configuration" therefore ends at "open the web page".
2. **Uploads.** The tool cannot set an avatar image, create a skill from an archive, or upload a
   plugin package. This holds even when the file is already in the conversation (generated,
   pasted, or built in the sandbox).
3. **Handoffs.** Where a person must decide on the web (an import's permission review, an OAuth
   consent), the tool returns a `reviewUrl` in text. Nothing on the card takes the person there.
4. **Stale reasons.** Several `internal` exclusions say "creation stays on the web". For example,
   `GET …/channels/schema/:plugin` and `GET …/connectors/kinds`. Once creation is an operation,
   these reads are needed.

Vision and memory models are already settable: `models.set-purpose`, `models.set-platform-purpose`.
The org admin's example fails today only when the chosen provider is not yet configured. Fixing
that is item 1.

## 3. Goals, non-goals, anti-goals

Goals:

1. **Secrets never pass through the model, and still the agent can drive configuration.** A
   write that needs a secret shows the person a card with input fields for exactly those secrets.
   The person types them, and the values go from the browser to the kernel. They never enter
   the event log, the tool result, the approval record, an audit row or a log line (§4).
2. **Files already in the conversation can be used where the web takes an upload** (§5).
3. **A decision that stays on the web is one tap away**: a link card pops up in the conversation (§6).
4. Every exclusion is re-audited against the new principle (§7). An exclusion stays only for a
   reason that holds even with these mechanisms.
5. The fence enforces the new rules (§9).

Non-goals:

- Agents deciding their own approvals, answering their own questions, or changing their own
  permissions (§7.3).
- Generating long-lived credentials for the agent: personal access tokens and service tokens stay
  off (§7.3).
- Extensions contributing Platform operations.
- A new review flow. Operations call the same services the routes call, as before.

Anti-goals (a failure even if it works):

- A secret value appears in anything a model, another member, a trajectory viewer or an eval can
  read.
- The model can make the card ask the person for something the target schema does not declare as
  a secret. That would be phishing through the card.
- A non-technical admin is sent to a page they cannot find, while the agent could have done the
  step with them.

## 4. Mechanism 1: person-entered fields

### 4.1 Shape

An operation whose route takes a secret declares which inputs are **person fields**. The model
never passes their values. It names which of them the person should enter:

```jsonc
// Platform call
{ "operation": "extensions.platform-set-config",
  "params": { "name": "anthropic",
              "values": { "baseUrl": "https://api.anthropic.com" },  // non-secret fields
              "askPerson": ["apiKey"],                                 // secret fields to enter
              "clearSecrets": [] } }                                  // secret fields to empty
```

Rules, enforced in the operation's input handling (shared, not per operation):

- `askPerson` and `clearSecrets` hold paths of fields the **target schema** marks secret. The
  marker is `x-secret` in an extension's config JSON Schema (from `secret()` in `config-ui.ts`)
  or a connector's `endpointSchema`. For kernel route schemas it is a zod `secret` meta on the
  shared schema. Any other path is refused with an actionable error. The person cannot be asked
  for anything else.
- A secret value in `values` is refused: "Secret fields are entered by the person on the
  confirmation card; leave `apiKey` out of values and list it in askPerson." The refusal does
  not echo the value. A value in `values` has passed through the model, so it counts as leaked
  (§4.5): the refusal also says so, and the agent tells the person to rotate it.
- A secret field the target requires and has no value for is added to `askPerson` by the kernel.
- A secret not named in `askPerson` or `clearSecrets` keeps its stored value, as on the web form.

### 4.2 The card

The confirmation card is the existing Platform approval (`requested_for` is the run's trigger
person, and the parameter hash binds what runs). It gains one input per person field:

- The label, description and widget come from the target schema's node: a password input for a
  string, a masked text area for a multi-line secret such as a service-account JSON. The model
  never supplies them.
- The card names the target: "Anthropic: deployment config" or "Connector GitHub (org)". It also
  shows the non-secret changes as the card summary does today.
- **Approve** submits the decision and the values together:
  `POST …/approvals/:id/decision { decision, inputs }`. The kernel validates each value against
  its schema node before accepting the decision. An invalid value keeps the card pending and
  shows the error in place, so the run does not fail on a typo.
- **Decline** sends no values.
- Person fields make an approval **web-only**:
  - IM approval cards show "需要在网页填写 N 项" ("N fields to fill in on the web") with a link to
    the conversation, and no approve button. A secret typed into an IM card would pass through
    the IM vendor.
  - The inbox entry links to the conversation the same way.
- Approvals with person fields are never rememberable (`rememberable: false` whatever the class).

### 4.3 Where the values live

Values go through a sealed, read-once store. This generalizes `account_initial_passwords`
(migration 0090) in the opposite direction:

- **The table.** `capybara.platform_sealed_inputs`:
  - `approval_id` (primary key), `recipient_account_id`, `conversation_id`, `run_id`, `call_id`;
  - `master_key_id`, `ciphertext` (AES-256-GCM with the master keyring, AAD = approval id plus
    the field paths);
  - `expires_at`, 15 minutes after the decision.
- **Writing.** The decision transaction writes the row together with the approval's state change.
- **Reading.** The resumed call reads and deletes the row in the transaction that applies the
  write. The handler gets the values through a call-scoped `sealedInputs` argument, never through
  `params`. It passes them to the same service method the route calls. That method stores secrets
  as it does today: `secret()` storage, encrypted credential columns.
- **Expiry.** A resume that never reads its row leaves it to expire. The hourly `@LockedCron`
  that cleans initial passwords also deletes expired sealed inputs. A resume that finds its row
  gone returns: "The values the person entered expired before they were applied; call the
  operation again."
- **Records.** The event log records which paths were entered (`inputsProvided: ["apiKey"]`),
  never the values. So do the approval record, the audit detail and the tool result
  ("apiKey: entered by the person").
- **Hooks.** `tool.call` hooks see the params, which carry no values. Observe hooks see the
  result, which carries no values.

### 4.4 OAuth and other browser flows

A connector's OAuth connect and a login-source binding run in the person's browser session. An
operation such as `connectors.connect` does not start the flow. Its card carries a **Connect**
button that opens the web flow; the existing route starts it from the person's session. The tool
result says: "The person was shown a Connect button; check connectors.get for the connection
state." The same card-link shape serves §6.

### 4.5 A secret that appeared in the conversation is leaked

Maintainer decision (Q3, 2026-11-20): anything that appeared in the conversation counts as leaked.
The model has read it, and the event log, trajectories and evals keep it.

- The tool never takes a secret from the conversation: not in `values` (§4.1), not as a prefill
  of the card. The card's inputs always start empty.
- When the person submits the card, the kernel checks each entered value (8 characters or more)
  against the conversation's own text: the user messages, assistant messages and tool results of
  the conversation and its sub-agents. A value found there is refused in place: "This value
  appeared in the conversation, so it counts as leaked. Create a new one at the provider and enter
  that." The card stays pending. The check reads the log in the decision request and never stores
  or logs the value.
- The refusal text the model gets names the field, not the value: "The person's apiKey appeared in
  the conversation earlier and was refused as leaked; ask them to rotate it."

## 5. Mechanism 2: files instead of uploads

An operation that mirrors an upload takes a **file reference**:

```jsonc
"file": { "fileId": "att_…" }   // a conversation file: attachment, artifact, Read copy
"file": { "path": "/workspace/dist/my-plugin.tgz" }  // a file on the conversation's device
```

- `fileId` resolves through `findConversationFile`, the resolver Read uses. Device paths are
  read through the device as Read does, with the same owner rules. This covers generated images,
  pasted screenshots, and archives the agent built in the sandbox (the co-build case).
- The route's byte limit and content-type rules apply unchanged: `AGENT_AVATAR_MAX_BYTES` and
  its content types, and `packages.maxBytes` for packages. Too-large files are refused before the
  card.
- The kernel stores the bytes as the upload route would, by a server-side copy into the same
  object key family, then calls the same service. No presigned URL is created.
- The card shows the file name, size and a sha256 prefix, plus a thumbnail for an image. The
  approval binds the sha256, so the bytes that run are the bytes shown.

Routes and the operations that mirror them:

| Upload route | Operation | Class |
|---|---|---|
| `POST …/agents/:agentId/avatar/uploads` with the profile PATCH `upload` variant | `agents.update-profile` gains an `avatar: { kind: "file", file }` variant | as `agents.update-profile` |
| `POST …/agents/:agentId/skills/uploads` | `agents.upload-skill` | `personal` (own agent) |
| `POST …/skills/uploads`, `POST …/skills` | `skills.create-from-file` | `org` |
| `POST …/catalog/uploads/file` | `plugins.upload`: stages and returns the review; confirming stays on the web (§6) | `org` |
| `POST /admin/catalog/import/file` | `plugins.import-file`: same handoff | `platform` |
| `POST /admin/extensions/packages/file` | `extensions.upload-package`: install stays human-only | `platform` |
| `POST /admin/components/skill/:id/versions` | `components.upload-skill-version` | `platform` |

Kept as exclusions: `POST …/attachments`, `…/finalize` and `GET …/attachments/limits` (category
`internal`). They exist to bring a person's file into a conversation, and the agent's files are
already there.

## 6. Mechanism 3: handoff link cards

A write whose decision stays with a person on the web has a place where that person decides: an
import or upload review, an extension permission approval, a connector tool review. Maintainer
decision (Q1, 2026-11-20): the decision stays on that page, and the conversation **pops up a link
card** to it. When the operation returns, the conversation shows a card naming what waits for the
person ("Review the permissions of plugin X") with one button that opens the page; the URL is in
the result's text for the model too. On IM the card is a message with the link. Today only
`marketplaces.import` and `plugins.import-npm` return a `reviewUrl`, as text. Every operation that
hands off gains the card.

"Guide the install" is then one conversation, with the agent preparing every step:

1. `marketplaces.entries` finds the plugin.
2. `marketplaces.import` prepares it; the link card pops up, the person taps **Review** and
   confirms the permission review on that page.
3. `extensions.platform-set-config` takes the API key on the card.
4. `extensions.platform-enable` enables the extension.
5. `setup.check` verifies the setup.
6. `plugins.set-scope` puts it on in the orgs.

## 7. Re-audit of the exclusions

### 7.1 The principle

An exclusion stays only when **the person themself must be the actor**, even with §4–§6, or when
the route has nothing an agent acts on. "It carries a secret" and "it is an upload" are no longer
reasons. The four categories stay, with narrower meanings:

| Category | Meaning after this change |
|---|---|
| `human-only` | The act is about the person's own identity, credentials or consent, or about the agent's own permissions |
| `secret` | The route delivers a secret to a browser: SSO / OAuth callbacks, the initial-password reveal, other orgs' config copies |
| `transport` | Bytes, streams, embeds, health, public share pages. Never an upload. |
| `internal` | A helper of a web screen with no agent use; states which operation gives the same facts |

### 7.2 Moving to operations

**Secrets** (person fields, §4):

- extension deployment config: read (secrets as set / not set), write, clear;
- org extension config and the org's config copy: take, save, drop;
- connector create, preview, endpoint edit, org credentials and own credentials (write and
  delete);
- connector-template connectors;
- catalog install and `catalog/:itemId/connectors` with their config and credentials;
- channel create;
- OAuth connect (§4.4).

**Uploads:** the table in §5.

**Stale internal reasons:** `GET …/channels/schema/:plugin` and `GET …/connectors/kinds` become
reads (`channels.schema`, `connectors.kinds`). A create operation needs the form schema to know
which fields are secret.

**Member management** (Q2, maintainer decision 2026-11-20: yes): `orgs.invite`, `orgs.revoke-invitation`,
`orgs.set-member-role` and `orgs.remove-member`, class `org`, never remembered. The invitation link
is revealed only on the web, to the person who approved, with the initial-password mechanism.
Never offered:

- raising anyone to a role above the actor's;
- changing the actor's own role;
- touching the owner.

`orgs.invitations` lists invitations without their tokens.

**Guide acknowledgements:** `channels.guide-ack` and `connectors.guide-ack`, class `personal`.
The card's text is the statement the person confirms ("I updated the app on Lark after the setup
guide changed").

### 7.3 Staying excluded

| Group | Why it stays |
|---|---|
| Login, logout, refresh, password, identity binding, SSO, current-org switch | The person's own identity and session |
| Personal access tokens, service tokens (create, list, revoke) | Long-lived credentials to act as the person or the org. An agent minting them outlives the conversation's confirmation. |
| Deciding tool approvals and network asks, answering questions, a conversation's permission selection, `first-message` | The agent would decide its own consent; these are already cards |
| A person's own connector tool policies, device policy, device pairing and disconnect | The agent's own permissions, or the machine's trust; decided on the machine or by the person |
| Extension permission approval, extension install, import / upload / item confirms, catalog and skill-change decisions, connector tool review | Trust decisions: the person decides on the review page, reached by the §6 link card (Q1) |
| Org create / delete / leave / ownership transfer, member decisions on others' requests | Whole-org or ownership acts; rare, and irreversible |
| Others' trajectories | Replay privacy (the trajectory viewer is audited as a human review) |
| `POST conversations`, `POST …/messages`, the deprecated queue | A run is started by its person, never by another run |
| Byte streams, SSE, embeds, UI actions, client code, health, public share pages | Nothing an agent acts on; an extension's agent capabilities are its tools |

## 8. Display

The web gets one new design component: the approval card's **person field** row. It has a label,
a description, a masked input and an inline error. It is built in `packages/design`, and the card
uses it as a design component (`check:web-ui`). Copy goes through i18n (zh and en). The zh terms
are 平台, 超级管理员 and 智能体.

The handoff link card and the file row (name, size, thumbnail) reuse existing card parts.

## 9. The fence

`check:platform-ops` and the parity test gain the following rules.

- **`platform-op-secret-param`** (parity test). A route schema field with the zod `secret` meta
  must be a person field of every operation that mirrors the route, and never a param. Red
  fixture: an operation whose input has the route's secret field.
- **`platform-op-upload`** (source scan). An exclusion whose reason or category names an upload is
  refused, except the three attachment routes, which carry the allowed reason. Red fixture: a
  transport exclusion "Uploads … as multipart bytes".
- **`platform-op-handoff`** (source scan). An operation whose description says a person confirms on
  the web must declare its handoff link. Red fixture: a description without it.
- The `secret` category's allowed set narrows to the §7.1 meaning. Review checks the reasons; the
  rule only checks that the category exists.

The runtime guard of §4.1 (no secret values in params, only declared paths) is shared code with
unit tests. It is not a check, because extension schemas are only known at run time.

## 10. Constraints

- **Multi-replica.** Sealed inputs are in PG with a TTL and a `@LockedCron` cleanup under
  `WorkerModule`. Nothing is in process.
- **Writes.** The decision writes the sealed row in the approval's transaction. The resumed call
  consumes it in the write's transaction, so the values are applied once or not at all.
- **Replay.** Results and events carry field paths, not values. Recorded tool results replay as
  they are, so no `DriftReason` is needed.
- **Security.**
  - The card asks only for fields the target schema marks secret (§4.1).
  - Values are validated against the schema node and bounded: 16 KiB per field, 32 fields.
  - The decision route accepts `inputs` only from the approval's `requested_for` person in a web
    session (`@SessionOnly()`); PATs and service tokens are refused.
  - Values are never logged; the request logger redacts the `inputs` body key.
- **Audit.** Writes through the tool keep `{ via: "agent", operation, agentConversationId,
  agentRunId }`, plus `inputsProvided` (paths).

## 11. Acceptance

On a deployment like prod (the former argus):

1. **An org admin with no technical background.** "把视觉模型设成 X, 记忆用 Y."
   - The agent reads `models.purpose-availability` and finds X's provider not configured for the
     org.
   - It walks the person through `extensions.set-org-config`, with the API key entered on the
     card.
   - It sets both purposes. The org's Models page shows them.
2. **A super admin installing from the marketplace**, following the steps in §6. The API key
   appears in no event, result, audit row or log line; a grep of the conversation's events and
   the kernel log for the key finds nothing.
3. **An avatar from a generated image.** `GenerateImage`, then `agents.update-profile` with
   `{ kind: "file", file: { fileId } }`. The card shows the thumbnail, and the agent's avatar
   changes.
4. **A skill built in the sandbox.** The agent packs a skill archive, then calls
   `skills.create-from-file` with a `path`. The org has the skill.
5. **Refusals.**
   - A secret in `values` is refused without being echoed.
   - `askPerson` naming a non-secret field is refused.
   - An IM approval with person fields shows only the web link.
   - A stale sealed input returns the "expired" error.
   - A key the person pasted into the chat earlier and then enters on the card is refused as
     leaked; a new key is accepted (§4.5).
   - `marketplaces.import` pops up the link card to the review page.
6. **The fence.** Each new rule is red on its fixture.

## 12. Decisions (maintainer, 2026-11-20)

- **Q1. Trust decisions.** They stay on their review pages. The conversation pops up a link card
  to the page (§6); the card itself does not render the review.
- **Q2. Member management.** Yes: invite, revoke invitation, role change and remove member, with
  the limits of §7.2. Ownership transfer, org deletion and leaving stay off.
- **Q3. Secrets in the conversation.** Refused. Anything that appeared in the conversation counts
  as leaked: the tool never takes it, and the card refuses a value the conversation contains
  (§4.5).

## 13. Delivery

One plan, three PRs by mechanism, each with its exclusions moved and its fence rule:

1. Person fields:
   - the sealed store (one expand-only migration);
   - the card row;
   - the decision route's `inputs` and the leak check (§4.5);
   - the extension and model-provider config operations (acceptance 1, 2).
2. Connectors, channels and catalog installs on person fields, plus OAuth connect and member
   management.
3. Files instead of uploads (acceptance 3, 4), and the handoff link cards.

## AGENTS.md rules touched

- **Platform tool.** The line gains: "a secret an operation needs is a person field entered on the
  card, never a param; an upload route is mirrored with a file reference
  (`check:platform-ops`)". `writing-kernel-api` and `writing-tools` describe person fields, file
  references and handoff link cards.
- **Multi-replica discipline.** Followed: the sealed inputs have a TTL in PG, a `@LockedCron`
  cleanup under `WorkerModule`, and writes in the decision's and the call's transactions.
- **Migrations.** One new expand-only table in schema `capybara`.
- **Web UI.** One new design component (the person field row), used by the approval card; copy
  through i18n.
- **Runtime and replay.** No new model-visible input: results carry field paths, not values.
