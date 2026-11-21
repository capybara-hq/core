# Permission profiles govern every approval; secure input; Auto

Status: approved by the maintainer on 2026-11-21 (the four decisions, the invariants and the two
resolved questions). The rest is the author's technical design. It amends the
[approval-only profiles design](2026-11-19-approval-only-profiles-design.md) ("Profiles", "UI",
"Kernel: decision, admission and records") and the person fields of the
[platform web parity design](2026-11-19-platform-web-parity-design.md) (§4).

## Why

In acceptance the maintainer read the three profiles the way the composer presents them: one
setting for every approval in a conversation. The code implements something narrower:

- **Only device work follows the profile.** That is Bash, file tools, Glob, Grep, and directory,
  host and outside-sandbox crossings. A Platform call, a connector tool or an extension tool with
  an `ask` policy still goes to the person under every profile
  (`ToolPipeline.decide` → `approvals.request`), so Full access still raises cards for Platform
  operations.
- **A device that cannot enforce scoped operations locks the whole picker.** Each option reads
  "此设备不支持", for example a local deployment still on `sandbox-docker` rc.16. The real cause is a
  plugin that needs updating, and it is not named. Approvals unrelated to the device become
  unreachable too.

## Decisions (maintainer, 2026-11-21)

1. **A profile governs every approval of the conversation.** Request approval asks the person for
   every approval. Approve for me lets the review model decide, falling back to the person. Auto
   asks nobody: the agent may act freely.
2. **Full access is renamed Auto** (zh 自动模式, en Auto). Only the display name changes: the
   stored and wire identifier stays `full-access`, and no migration is needed.
3. **Secure input is not an approval.** When a call needs a secret from the person (a password, a
   token, an API key), the agent requests it, and the person enters it in a dedicated input. The
   value goes to the tool and never to the model, which sees only the request's id and state. It
   is asked under every profile, Auto included, because it is input, not consent.
4. **A device without scoped operations keeps the profiles.** Every profile stays selectable.
   Device tools refuse with an actionable reason ("this device's sandbox plugin needs an update
   before commands can run"). The picker shows that reason once, at the top, instead of a badge on
   each option.

## Invariants (author, for review)

- **A profile is the person's own consent.** It never decides an approval addressed to someone
  else: `approverRole` set (super admin, org admin), or `requestedFor` another account. Those still
  go to that role or account, as today. A member's Auto must not become a way around a super
  admin's approval. When the person is that super admin, the profile applies to their own approvals
  as to any other.
- **Policy denies stay denies.** A tool, platform or org `deny` and the sandbox's fixed denies hold
  under every profile, Auto included. A profile chooses who approves; it never widens what is
  allowed.
- **Unattended runs** (scheduled tasks) are unchanged: Request approval with every ask turned into
  a deny. Secure input is refused there too, as person fields are today.
- **Every automatic decision is recorded.** The approval, or for Auto the call, carries
  `decisionSource: "full-access"` or `"review-model"` and the profile revision, as device crossings
  do, and an audit row. Nothing an Auto conversation does is silent.

## Profiles, per request

| Request | Request approval | Approve for me | Auto |
|---|---|---|---|
| Device work inside the sandbox scope | Runs | Runs | Runs |
| Device crossing (directory, host, outside-sandbox), sensitive command | Ask | Review model | Auto-grant, recorded (current Full access rules, including the two review-model exceptions below) |
| Tool with policy `ask` (Platform operation, connector tool, extension tool, MCP), addressed to the person | Ask | **Review model** (new) | **Runs, recorded** (new) |
| Approval addressed to another role or account | That role or account | Same | Same |
| Secure input (secret fields) | Secure input card | Same | Same |
| Result shown once to the person (an initial password, an invitation link) | Runs after approval; the result card shows it | Review model, then the result card | Runs; the result card shows it |
| Policy deny, fixed deny, beyond a ceiling | Deny / unavailable | Same | Same |

These are kept from the 2026-11-19 design (maintainer, 2026-11-21):

- Under Auto, an outside-sandbox crossing carrying a credential consent, and a sub-agent's
  outside-sandbox escalation, still go to the review model.
- Rememberable grants ("this session" / "always") still apply first under every profile: an
  existing grant runs without asking.

## Approve for me on tool calls

- The review model judges a tool ask the same way it judges a command ask, with its own review
  purpose (`tool`). Its input:
  - the tool's key and title;
  - the kernel-rendered summary (the card's sentence);
  - the input, with secret fields removed;
  - the conversation's recent person messages, so it can judge intent.
- An allow runs, and a deny returns an actionable refusal. Unsure, unavailable or failing asks the
  person, as for commands.
- The review model's text stays neutral (mechanism, not a patch for one observed slip).
- A prompt-injected allow is bounded by the invariants: it can never cross a policy deny, another
  role's approval or a secret.

## Secure input

The person fields of the parity design (§4) already do most of this. The model names the secret
fields with `askPerson` and never passes their values. The values go to a sealed, read-once store
that the tool reads, and the card is web-only, never in IM. What changes:

- **It is its own request, not an approval.** A call whose only reason to ask is secret fields
  raises a secure input card with Submit / Cancel. It has no Approve and no scope choice, and it
  carries no consent: the call's own approval, if any, follows the profile on its own. Under Auto a
  Platform call with `askPerson` runs as soon as the values are submitted.
- **The model sees the request's id and state only:** pending, submitted or cancelled, never the
  values. This is unchanged from person fields.
- **Transport:** values travel over HTTPS from the web form straight to the kernel's sealed store,
  as today. The stored values are encrypted at rest (as `account_initial_passwords`) and deleted
  when read or expired.
- **Later, not in this change:** a connector or extension may declare secret inputs of its own
  tools the same way. Today only Platform operations and config schemas do.

## A device without scoped operations

- Admission stops gating the profile on device support. The conversation's permission context
  reports `availability` for **device work** only. The picker offers the three profiles whatever it
  says.
- A device tool on such a device fails before anything runs, with an actionable text that names the
  cause. For an outdated provider plugin, for example: "This device's sandbox plugin
  (sandbox-docker 0.1.0-rc.16) cannot run commands under a permission profile; a super admin
  updates it in 插件." For a machine that is not checked yet, the text names that instead.
- The picker shows one muted line at its top with the same reason, replacing the per-option
  badges.

## UI

- **Composer mode menu:** 请求批准 / 帮我批准 / 自动模式 (Request approval / Approve for me / Auto).
  The descriptions now speak of every approval, not only the sandbox:
  - 请求批准：每个审批都先问你。
  - 帮我批准：审查模型替你判断，拿不准时问你。
  - 自动模式：不再询问，智能体可以自由操作；需要别人批准的、需要你输入密钥的仍会出现。
- **The Auto confirmation** keeps its one-time confirmation per device and scope revision. Its text
  now also says that Platform and connector actions run without asking.
- **Secure input card:** a design `ApprovalBlock` variant with the secret fields, Submit and Cancel,
  and the target named. Its reference blocks and states follow spec §10.
- **Copy elsewhere:** the device settings, the inbox and the docs that say "完全访问" / "Full access"
  change to 自动模式 / Auto. The identifier `full-access` stays.

## Kernel

- **`ToolPipeline.decide` gains the profile step** for asks addressed to the person:
  - Request approval: the ask, as today.
  - Approve for me: the tool review, then an ask on unsure.
  - Auto: an allow, recorded.
  
  It applies after the call policy and grants, and before `approvals.request`. Asks addressed to a
  role or another account skip it.
- **Secure input splits from approvals.** A call whose ask exists only for person fields raises a
  `secure_input` request, a new approval kind or its own table (the plan decides). It is excluded
  from the profile step. A call with both an ask and secret fields raises the secure input after
  the profile decides the ask.
- **The profile resolves from the root conversation's permission context**, as for device
  crossings. A conversation without a device context, such as a cloud agent with no device, still
  has its selected profile.
- **Replay:** decisions are recorded on the tool result's `review` field, which is not
  model-visible, as for commands, so no `DriftReason` is needed. A secure input's state is in the
  log as an approval's is today.

## Migration and compatibility

- No stored data changes. `full-access` keeps its value, and existing conversations keep their
  profile.
- The behavior change for existing conversations is the point of the change: tool asks under
  Approve for me and Full access stop raising person cards. Release notes say so.

## Resolved questions (maintainer, 2026-11-21)

1. Auto keeps its two review-model exceptions: an outside-sandbox crossing carrying a credential
   consent, and a sub-agent's outside-sandbox escalation.
2. Approve for me's tool review sees the last few person messages of the conversation, bounded in
   count and size, not the whole conversation.

## AGENTS.md rules touched

- **Sandboxes:** "a profile only chooses who approves a crossing (person, review model, nobody)"
  becomes "a profile chooses who approves every approval addressed to the person (person, review
  model, nobody); another role's approval and secure input are never decided by it". This rule is
  amended in the same change as the implementation.
- **Platform tool:** unchanged. Person fields become secure input; their schema rule
  (`askPerson`, `x-secret`) stays.
