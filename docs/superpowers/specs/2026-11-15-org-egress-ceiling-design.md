# Org egress: follow the platform, and a ceiling the super admin can set

Status: design, 2026-11-15. This fixes the design-review finding `org-egress-replaces-deployment`
(high, security). It was first seen in 2026-11-12-2 and came back in 2026-11-14. An independent
review of the first draft (one blocker, six majors) has been folded in.

## 1. Problem

An org's sandbox network setting is `cloudNetwork: { mode: "open" | "allowlist", allowHosts? }`
(auto mode spec §4.3). When `allowHosts` is given, it **replaces** the platform's
`sandbox.limits.allowHosts`. That causes two problems:

- **Detachment.** Approving the org's first network request
  (`RequestsService.approveNetwork`) copies the platform list into the org and appends the new host.
  From then on the org no longer follows the platform: a host the super admin later removes stays
  allowed, and a host they later add never arrives. Nothing tells anyone this happened. Saving the
  host list on the settings page has the same effect.
- **No ceiling.** The super admin cannot stop an org from going beyond the platform list. An org can
  add any host, and it can choose the `open` cloud network. The platform's only control is the kill
  switch, `sandbox.limits.egress: none`. The platform list is a default, not a limit.

The list matters beyond cloud devices. `orgAllowedDomains` makes the org's hosts the ceiling of
every **local** device in sandbox mode (`localAllowedDomains`), so detachment freezes that ceiling
too.

## 2. Decisions

### D1. The org stores a delta, never a copy

The new stored shape (every field optional):

```ts
cloudNetwork: {
  mode?: "open" | "allowlist";       // absent: follow the platform's default (open)
  base?: "platform" | "none";        // absent: platform
  extraHosts?: string[];             // hosts the org adds
  excludedHosts?: string[];          // platform entries the org drops (base platform only)
}
```

- **`base: "none"`** means "only the hosts I list". It replaces today's explicit `allowHosts: []`.
  It is also what an invalid stored value reads as: `{ mode: "allowlist", base: "none" }`, the empty
  allowlist, which keeps the never-wider rule.
- **List rules.** Each list has at most `ORG_SANDBOX_ALLOW_HOSTS_MAX` (200) entries, no duplicates,
  and every entry passes `validateAllowHost`. `excludedHosts` is **not** required to be a subset of
  the platform list: when the platform later drops an entry, the stored value must stay valid.
- **No compatibility.** `allowHosts` leaves the schema; before 0.1.0 there is no compatibility
  layer. A stored value that still carries `allowHosts` fails the strict schema and reads as invalid,
  which means the empty allowlist (see rollout, D5).

The org's **effective hosts** are computed as follows:

```
if egress == "none":       []
extra = extraHosts; under orgHosts == "within" keep only those a platform entry covers
hosts = base == "none"
      ? extra
      : dedupe((platform.allowHosts minus excludedHosts, exact) ++ extra)   // platform order first
```

**"Covers"** is the sandbox's own matcher (`covers` in `local-devices/network-grants.ts`, moved to
`sandbox/modes.ts` and imported back):

- an entry `p` covers `p`;
- `*.d` covers any name ending in `.d`, including a narrower wildcard `*.a.d`, but never `d`.

An approval adds a host to `extraHosts`, or removes it from `excludedHosts` when the host is an exact
platform entry that the org had dropped. It never copies the platform list and never writes `mode`.

### D2. A platform ceiling: `sandbox.limits.orgHosts`

The new field is `sandbox.limits.orgHosts: "extend" | "within"`, with default `extend`.

**`extend`** keeps today's product. The org may use the `open` cloud network and add hosts, and org
admins approve network requests.

**`within`** makes the platform list the ceiling of everything the org controls:

- **Hosts.** Extras outside the platform list are ignored on read. Under the org lock, for people
  and tokens alike, a write is refused (`org.sandbox_egress_not_allowed`, naming the host and saying
  "ask a super admin to add it to sandbox.limits.allowHosts") only for an extra host outside the
  ceiling that the stored value does not already hold.
- **Cloud network.** In sandbox mode the org's cloud network is always the allowlist: the effective
  mode is `allowlist` whatever is stored. Writing `mode: "open"` is refused only when the stored mode
  is not `open`. Stored values have no effect under the ceiling, and the PATCH replaces
  `cloudNetwork` whole, so they are always sent back as they are. Refusing them would block every
  approval and save.
- **Network requests.**
  - Creating a request is refused (`catalog.request_invalid`) when any of its hosts is outside the
    ceiling. The error names those hosts and the super admin.
  - Approving a request refuses it whole in the same case, so no host is ever granted partially.
- **Wording, no new layer.** A blocked host stays in the `org` layer (the SDK's `NetworkBlockLayer`
  and the `network_blocked` event are unchanged). Where the kernel writes the model-visible note
  (`planNetworkAsk`), it splits the `org` hosts with `orgHostOutsideCeiling`: those outside the
  ceiling get "only a super admin can add it to the platform's allowlist" instead of the org admin
  note. The scheduled-task refusal (`needs_admin`) gets the same wording for them. Both take the
  check as an optional `outsideCeiling(host)` in their context. Tool results are in the event log,
  so the text change needs no `DriftReason`. The web relies on the kernel's refusals (the ask and
  the save name the super admin) instead of copying the matcher.
- **Auto mode is not limited by `orgHosts`.** A cloud device in auto mode uses the open public
  network, and a local one uses the machine's network. Both are governed by `devices.autoMode`. The
  config description says so, and startup logs a warning when `orgHosts: within` is combined with
  `devices.autoMode` allowed (the admin console's runtime change of `devices.autoMode` is a
  follow-up: the console should show the combination).

**Why `extend` is the default:** on 2026-11-14 the product decided that the org's cloud network is
`open` by default and that an org admin's approval is how sandbox mode widens. A `within` default
would silently break network requests on every default deployment. Detachment is fixed for
everyone, and the ceiling becomes an explicit choice that the super admin can now make.

That this choice exists, instead of an always-on ceiling, is recorded as the maintainer's ruling for
the next design review (the finding then reads "detachment fixed, ceiling explicit").

The field is read live on every use, like `allowHosts`, and is not `hot`. Under a rolling config
change the read-time filter keeps replicas safe while they disagree.

### D3. One derivation

`packages/kernel/src/sandbox/modes.ts` owns:

- **`orgEffectiveHosts(limits, cloudNetwork)`**: the rule in D1.
- **`orgCloudMode(limits, cloudNetwork)`**: returns `allowlist` under the kill switch or `within`,
  otherwise `cloudNetwork.mode ?? "open"`.
- **`orgHostOutsideCeiling(limits, host)`**: returns true when `within` is set and no platform entry
  covers `host`.

`limits` is `Pick<sandbox.limits, "egress" | "allowHosts" | "orgHosts">`.

These functions are the only places where the platform and the org are combined. The following now
call them:

- `orgAllowedDomains` and `deviceNetwork`;
- `sandboxAllowlist` (requests; it becomes `orgEffectiveHosts`);
- the devices view's `source`;
- `GET` settings.

`orgSandboxNetwork` is deleted.

**`assertOnlyNarrows`** (the Platform tool, API tokens) compares the **stored deltas**. Comparing
effective values would let a token store a widening that stays hidden under the kill switch or
`within` and takes effect when the platform relaxes. Normalize absent fields first
(`mode` → open, `base` → platform, lists → `[]`). A patch widens when any of the following is true:

- its mode is `open` and the stored mode was `allowlist`;
- it moves `base` from `none` to `platform`;
- with `base: platform`, it drops an entry of the stored `excludedHosts`;
- one of its `extraHosts` is not covered by a stored extra.

Moving from `base: platform` to `base: none` with a platform entry as an extra is a narrowing
that these rules refuse. That refusal is safe and is accepted, with a note in the test. A token
therefore cannot pin a host that today comes from the platform list as an extra, because
the org would keep it after the platform removes it. `null` (follow the platform) is the patch
`{}` and is judged by the same rules.

### D4. API and UI

**`GET` / `PATCH /orgs/:orgId/settings`, and the Platform ops `org-settings.get` / `.update`:**

- `settings.cloudNetwork` is the stored delta.
- `deployment.cloudNetwork` becomes `{ allowHosts, orgHosts, off }`.
  - `off` is the kill switch.
  - Its `mode` field is removed. Readers that used `mode === "allowlist"` to mean the kill switch
    (`NetworkFacts`, the settings page) read `off` instead.
- A new top-level `effectiveNetwork: { mode, hosts }` is the org's effective sandbox-mode network
  from D3. The page shows it as is.
- The update op's description names `extraHosts` / `excludedHosts` / `base` and the `within`
  refusal. Its input follows `CloudNetworkSettingSchema`, and the parity test keeps the two in step.

**Settings page:**

- The host editor is shown in **both** modes. It is the local sandbox ceiling even when the cloud
  network is open, and its help text says so. It starts from `effectiveNetwork.hosts`.
- **PATCH replaces `cloudNetwork` whole**, so on save the web sends the stored value with the edited
  fields changed, never a partial one:
  - `mode` is the stored `mode` (absent stays absent) unless the person changed it;
  - `base` is the stored `base`; only "follow the platform" (`cloudNetwork: null`) changes it back;
  - the hosts are derived from the edited list `L` against the platform list `P`:
    - with `base: platform`: `extraHosts = (L − P) ∪ (stored extras ∩ L)` (a stored extra the
      platform now lists too is kept, so the org keeps it if the platform drops it) and `excludedHosts = (P − L) ∪ (stored excluded −
      P)`, so an exclusion of an entry the platform dropped survives in case it comes back;
    - with `base: none`: `extraHosts = L`.
- Under the kill switch (`off`), the editor is read-only and `cloudNetwork` is never sent.
- Under `within`:
  - the open option is disabled, with a note that the platform limits hosts to its list;
  - a host outside the list is reported by the kernel's refusal, which names the host. The web
    keeps no copy of the matcher (finding `allow-host-rules-copied`);
  - saving drops stored extras outside the ceiling, because the editor shows only effective hosts.
    That is intended: they had no effect.
- The `?allowHost=` prefill works as today. A prefilled host outside the ceiling ends in the
  kernel's refusal when the person saves.

**`NetworkFacts`:** reads `off` instead of `mode === "allowlist"` for the kill switch. Other
behaviour stays the same. Under `within`, a member's ask for a host outside the ceiling is refused,
and the refusal names the super admin; the dialog already shows refusal messages.

### D5. Migration `0134_org_cloud_network_delta.sql` and rollout

A migration cannot read the deployment's config, so it **keeps each org's current list exactly
and never widens it**. For every org where `settings->'cloudNetwork'` is an object whose
`allowHosts` is an array of distinct strings:

- `base: "none"`;
- `extraHosts` = the array as it is, in order. Omit the field when the array is empty.
- `mode` is kept, and `allowHosts` is removed.

Other rows are left alone: a non-array `allowHosts` copied in by 0130, duplicates or non-string
elements. The old reader already read those as invalid, that is, empty, and the new one does too;
converting them would widen them. The migration is idempotent: it only touches rows that still
carry an array `allowHosts`.

Under `extend`, a migrated org's effective list is exactly what it was. It stays detached, as it is
today, until an org admin chooses "follow the platform" (editing the list keeps `base: none`). `docs/deploy/upgrade.md` says so.

**Rolling upgrade.** An old replica that is still running after 0134 can write `allowHosts` again,
when it approves a request or saves settings. The new kernel reads that value as invalid, which
means the empty allowlist. That fails closed, never wider. The upgrade notes tell operators to
avoid org network edits and approvals during the rollout, or to re-save the org's network
afterwards. Before 0.1.0 we accept this instead of adding a reader for the old shape.

### D6. Instances

Changes to the host list reach only instances created after the change (sandbox skill, "Mode and
network follow running instances").

A mode change, such as `within` turning `open` into `allowlist`, takes the existing `update` /
recreate path. On a `limitsApplyAt: "fileSystem"` provider (E2B), a running instance keeps the open
network until its files are reset (`pendingFilesReset`). This is the known finding
`egress-narrowing-not-live-on-cloud-devices`, which this change does not widen.

## 3. Tests (each written red first)

**Unit `modes.test.ts`:** `orgEffectiveHosts`, `orgCloudMode`, `orgHostOutsideCeiling`

- a delta over the platform list;
- excluded entries;
- `base: none`;
- the kill switch;
- `within` drops uncovered extras and keeps those covered, including `*.a.d` under `*.d` and not
  `*.d` under `d`;
- `within` forces the allowlist;
- the invalid value reads as empty.

**Integration `orgs/settings.test.ts`:**

- PATCH with `allowHosts` is refused by the schema;
- under `within`, a new uncovered extra and a new `open` are refused, for both people and tokens;
  stored ones sent back are accepted (an approval for an org storing `{ mode: "open", extraHosts:
  ["x.example"] }` succeeds);
- the `onlyNarrows` rules in D3, each one;
- a token's widening is refused under the kill switch.

**Integration `catalog/network-requests.http.test.ts`:**

- approval writes only `extraHosts`, or removes the host from `excludedHosts`, and never writes
  `mode`;
- after an approval, a platform list change reaches the org: both narrowing and widening, in GET
  `effectiveNetwork` and in `orgAllowedDomains`;
- under `within`, creating or approving a request with an uncovered host is refused.

**Network asks / grants:** under `within`, an uncovered `org` host gets the super-admin note, and a
scheduled-task grant of it is refused with the super-admin wording.

**Migration test `0134`:**

- an array becomes `base: none` plus extras, in order and deduped;
- `[]` becomes `base: none`;
- a non-array `allowHosts` and non-string elements are handled;
- a row without `allowHosts` is untouched;
- running it twice gives the same result.

**Web `settings-sandbox.test.tsx`, `network-facts.test.tsx`:**

- the editor shows in both modes and derives the delta;
- `mode` is sent only when it changed;
- under `within`, open is disabled;
- `off` replaces `mode`;
- the save keeps the stored `mode` and `base` and a stale exclusion; `off` sends nothing.

**Fixtures to update:**

- kernel: `orgs/settings.test.ts`, `platform/ops-channels-settings.test.ts`,
  `tools/registry.test.ts`, `catalog/network-requests.http.test.ts`,
  `platform/ops-workspace.test.ts`, `sandbox/sandbox.service.test.ts`, `sandbox/modes.test.ts`;
- web: `apps/web/test/support/agents.ts` and the settings tests.

## 4. Docs

- Auto mode spec §4.3 and §4.4.
- `writing-sandbox-providers` and `writing-kernel-api` (the org settings paragraph).
- `docs/config.md` (generated).
- `docs/deploy/upgrade.md`.
- A changeset on the kernel and `@capybara-hq/capybara`.
- zh / en messages.
