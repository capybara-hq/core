# SDD ledger — plan: docs/superpowers/plans/2026-11-04-agent-profile-and-new-chat.md
Spec: docs/superpowers/specs/2026-11-04-agent-profile-and-new-chat-design.md (approved 2026-11-04)
Start: 92ac336d

## Pre-flight scan
| Pair / task | Produces vs consumes | Found |
|---|---|---|
| T1→T2 | AgentAvatar incl. upload; updateProfile | T1 defines the upload kind, T2 implements it |
| T1/T2→T5 | profile routes, avatar route, 409 code | consistent |
| T3→T7 | instructionFiles, mismatch 400 | consistent |
| T4→T6/T8/T9/T10 | Avatar, AvatarPicker, presets list | consistent |
| T5→T6/T7/T8/T10 | useUpdateProfile, avatarValue, uploadAvatar | consistent |
| T6→T7 | AgentPage, useSectionDraft, AGENT_SECTIONS | consistent |
| T7/T8 | AgentForm.tsx kept for create or deleted | consistent (T7 decides, T8 follows) |
| T8→T10 | greetingBucket, pickGreeting, sub line | consistent |
| T9→T10 | Greeting, AgentRow, AgentPanel, QuickActions, page slot props | consistent |
| T1 self | migration 0066 | another machine (tool rename) may add migrations concurrently |
| T3/T7 vs other machine | definition.ts tools refs, AgentForm tools section | tool rename touches the same files |
| others self | tests vs code vs files | consistent |

Ruling: T1 adds the `upload` kind to the type and schema, but a PATCH with an upload avatar is 400 until T2 wires it — keeps T1 testable alone — cost: none
Ruling: migration numbers are the next free number after `git pull --rebase` at commit time, not a fixed 0066 — the other machine may land a migration first — cost: none
Ruling: before each task and each commit, pull --rebase; on conflicts with the tool-rename work prefer its tool names and definition changes and re-run the covering tests — two machines on one branch — cost: a rebase per task
Task 1: review approved (0 critical/important)
Ruling: review minor 1 (backfill turns an empty/non-string avatarUrl into a junk external URL) is fixed now, not deferred — a migration is immutable once applied and the shared acceptance DB applies it on the next kernel start — cost: one small fix round
Task 1: minor (taken in the same round): avatar null stored as JSON null instead of SQL NULL; an expectedUpdatedAt-only PATCH writes and audits fields []; migration comment says updated_at
Task 1: minor (deferred): no permission test for /profile (guest / non-owner) and no upload-on-create test
Task 1: fix round 1/5 (3 addressed, 0 open; commits 581ae7e9..eee10d0f)
Task 1: complete (commits 92ac336d..eee10d0f, review clean)
Task 1: minor (deferred): no positive backfill test case; the no-audit assertion is not scoped to the agent id; report lists counts not test titles
Task 1: note: this machine's dev kernel (started 13:02) never ran 0066 at 581ae7e9 (13:28); the other machine's kernel might have, between 13:28 and eee10d0f — user to confirm, else a checksum mismatch at its next start
Ruling: create with an upload avatar stays 400 (the upload route needs the agent id); the create form (Task 8) creates with the preselected preset, then uploads and PATCHes the profile when the person chose an upload — no kernel change — cost if wrong: a brief preset avatar before the upload lands
Task 2: review approved with 1 Important (replaced/cleared avatars leak the object and row) → fix round 1
Task 2: minor (taken in the round): create-with-upload 400 untested; new URL() on a malformed backfilled external → 500
Task 2: minor (deferred): prepareAgentAvatar runs before lockForWrite (a non-owner finalizes their own upload before the 403); no-store GET test accepts 404|503
Task 2: fix round 1/5 (3 addressed, 0 open; commits 94e99606..19c18918)
Task 2: complete (commits eee10d0f..19c18918, review clean)
Task 2: minor (deferred): delete test asserts the row is gone, not the object; create-with-upload 400 test checks no error code; deleteIn transaction boundary not visible in the diff
Ruling: an update that sends neither instructions nor instructionFiles keeps the current prompt (it used to clear it to "") — safer, and required by the no-new-version test — cost if wrong: an API client that relied on clearing by omission must send instructions: ""
Task 3: review Needs fixes — Important: (1) org agent sub-agent copy spreads instructionFiles into subagent_started.definition (spec: no log event changes shape); (2) interim web regression: AgentForm spreads existing.definition, so an agent with instructionFiles gets 400 agent.instructions_mismatch when its prompt is edited in today's web
Ruling: (2) gets a minimal web fix now — AgentForm drops instructionFiles from the spread and sends instructions only — and Task 7's dispatch carries the rule "send instructionFiles without a stale instructions" — web users can edit every agent in between — cost if wrong: an interim save of a multi-file agent from today's form flattens it to its joined text (model sees the same)
Ruling: file names reject control, bidi and format characters (like titles) and are unique case-insensitively — names enter the model-visible prompt as headers; AGENTS.md vs agents.md would confuse people — cost: none
Task 3: minor (taken in the round): eval candidate keeps a stale instructionFiles after an instructions override — strip it
Task 3: minor (deferred): CRLF normalisation on web edit (Task 7 round-trip); a single file over 100 000 reports two issues
Task 3: fix round 1/5 (4 addressed, 1 new — an unrelated web save of a multi-file agent drops instructionFiles and creates a version; commits 3beed5bc..2e913b0f)
Ruling: deriveInstructions keeps current.instructionFiles when the request sends only instructions and it equals joinInstructionFiles(current.instructionFiles) — the kernel protects every client, not only today's form — cost: none
Task 3: minor (deferred): no CJK file-name test; the eval subagentVersion path of withInstructions untested
Task 3: fix round 2/5 (1 addressed, 0 open; commits 2e913b0f..ac0cb752)
Task 3: complete (commits 19c18918..ac0cb752, review clean) — row-lock derivation confirmed in the first Task 3 review (agents.service.ts:543)
Task 3: note (carried to Task 7): the web must send instructionFiles WITHOUT a stale instructions (else 400 agent.instructions_mismatch); old agents show readInstructionFiles' single AGENTS.md (the view does not normalise)
Task 4: review Needs fixes — Important: elephant reads poorly (from ASCII); controller-confirmed gap: at 22 px the 2-unit art (24 px) is clipped 1 px per side, losing edge art (panda, bear, fox)
Ruling: the elephant stays for the user's drawing review (plan: first-pass drawings are reviewed by the user; the rendered screenshot reads as an elephant) — not a fix-loop item — cost if wrong: one redraw later
Ruling: Avatar size 22 becomes 24 (unit 2 fits exactly, no clipping); later tasks use 24 where the plan says 22 (agents row chips) — cost: none
Task 4: minor (taken): radiogroup on display:contents may lose its role; the upload tile's failed image shows an empty initial
Task 4: minor (deferred): mid-tone dark grounds for black bear, panda, penguin; secondary colours not in contrast pairs; generic uploadOff copy (Task 6 passes a reason); fox cheek pixels at the edges
Task 4: fix round 1/5 (3 addressed, 0 open; commits 64ffc12a..fb8a5733)
Task 4: complete (commits ac0cb752..fb8a5733, review clean)
Task 4: minor (deferred): no size-table row for the 24 initial font; picker upload tile may wrap alone in narrow containers
Task 4: note: dev web served stale server modules after the design change (all layers drawn as the full silhouette) until restarted — remind the user to restart dev web after pulling design changes
Ruling: useUpdateProfile lives in lib/query/mutation.ts, not lib/query/agents.ts (check:web-ui web-lib-client-hook forbids hooks there); Tasks 6-10 import it from lib/query/mutation — the check is the authority — cost: none
Task 5: review Needs fixes — Important: two quick profile saves read the same cached updatedAt → the second 409s against the first
Task 5: minor (taken): agent.profile_unloaded has no i18n; uploadAvatar untested; no sequential-save test
Task 5: minor (deferred): cached Agent.updatedAt not touched after a profile save (fine if the kernel doesn't bump it)
Task 5: fix round 1/5 (3 addressed, 0 open; commits 644fa79a..07c6ece3)
Task 5: complete (commits fb8a5733..07c6ece3, review clean)
Task 5: minor (deferred): a hanging profile save holds back later saves of that agent (no timeout)
Task 6: review Needs fixes — Important: (1) the leave confirm covers only the section nav (sidebar, breadcrumb, head links and tab close drop edits silently); (2) always-visible ActionRow contradicts T5 (Settings: only when there are changes)
Task 6: minor (taken in round 1): profile/agent invalidation race; readiness not invalidated on a visibility change; upload type not checked beyond accept; edits typed during a pending save are lost
Task 6: minor (carried to Task 7): LegacyFormSection remounts on currentVersion (typed edits lost on refetch); legacy sections keep Save enabled when clean
Task 6: minor (deferred): members visibility offered when the member list can't load; PageHeader avatar slot has no spec state / size row (follow-up visual-update); reverse partial failure, version_conflict reload, members save and double-click untested
Ruling: browser back/forward (popstate) stays uncovered by the leave guard — Next has no route-blocking API — cost: an edit is lost on Back
Task 6: fix round 1/5 (5 addressed, 1 open — hash-only links prompt (skip link), target=_blank/download untested; commits 70b80a7d..e3df7132)
Task 6: minor (deferred): disabled preset tiles look the same as enabled; the subagents no-settings case now saves the Tools section
Task 6: fix round 2/5 (1 addressed, 0 open; commits e3df7132..c0468b55) — controller ran the hash-only test: 1 passed
Task 6: complete (commits 07c6ece3..c0468b55, review clean)
Task 7: review Needs fixes — Important: the Prompt section's loading skeleton (one titled FormSection, a 6-row textarea) doesn't match its loaded structure (untitled Grid columns="form": 220px list + Card with name Input and 16-row Textarea); no section title; the form grid has no narrow breakpoint
Ruling: the Prompt section sits in a titled FormSection like the others; the list + editor layout collapses to one column below 640 px, owned by the design package (a Grid variant or the form grid's own breakpoint, spec'd); the skeleton passes the real shape (list rows + editor card with a name field and a 16-row textarea) — Q6 and section composition hold — cost: a small design change
Task 7: minor (taken): name hints inconsistent (live invalid while typing a new name, nothing for a rename to an existing name until save)
Task 7: minor (deferred): CRLF → LF on edit (a whitespace-only version); undo after delete restores the snapshot and drops edits made in between; untested: deleting a middle file, >100 000 refusal, connector policy removal; duplicated create-form logic (Task 8) and warnings card (two copies)
Task 7: fix round 1/5 (2 addressed; new: inside a two-column FormSection the prompt editor is ~300 px on desktop — unusable for long prompts; commits 9be36787..fcb74476)
Ruling: FormSection gains a documented `stacked` layout (head above, fields across the full content width); the Prompt section uses it, its skeleton too — keeps a titled section and gives the editor room — cost: a small design variant
Task 7: fix round 2/5 (all addressed, 0 open; commits fcb74476..73c36e79)
Task 7: complete (commits c0468b55..73c36e79, review clean) — controller measured the prompt textarea at 592 px on a 1920 px window after restarting dev web and dev kernel
Task 7: minor (deferred): Repeater :has() rule and the list-detail collapse checked by CSS-text tests only; no skeleton-alignment pair for list-editor/stacked
Note: the dev kernel was restarted at 15:48 with Tasks 1-3 (migrations 0066, 0067 applied to the shared acceptance DB, no checksum error); an old kernel made /agents/<id> fail with 503 (the web reads profile.description)
Task 8: review Needs fixes — Important: (1) removed model-params tests were the only coverage of ModelSection's model/fallback/param-drop behaviour; (2) pickGreeting silently falls back to zh
Ruling: the create form's model defaults to the first available model — the kernel has no org default chat model (KERNEL_PURPOSES has eval/title/subagent only) — recorded as a spec §2.4 note — cost: a new agent may start on a model the org didn't prefer
Ruling: create focus goes to the name (the one required field), not the avatar group — cost: none
Task 8: minor (taken): ?avatar=failed is never cleared from the URL; missing web changeset
Task 8: fix round 1/5 (6 addressed, 0 open; commits a27690b8..1aa9c52e)
Task 8: complete (commits 73c36e79..1aa9c52e, review clean)
Task 8: note (carried to Task 10): pickGreeting(bucket, name, lines: GreetingLines, random?) — pass t.raw("greeting") / the locale's chat.greeting; it has no caller yet
Ruling: the AgentPanel is a two-column grid (as in the Octok reference and spec §4.2 "two-column rows"), arrow keys move in 2D — the implementer built one column — cost: a small layout and keyboard change
Task 9: review Needs fixes — Important: (1) the panel is one column (ruling: two-column grid, 2D arrows); (2) the panel search ignores IME composition (Enter confirming pinyin selects an agent)
Task 9: minor (taken): quick-action overflow menu has no max width; panel height doesn't shrink to the viewport; no StrictMode / text-change greeting tests; data-start keyed on greeting only
Task 9: minor (carried to Task 10): after selecting an agent focus returns to 更多 — Task 10 focuses the composer in onSelect
Task 9: note (carried to Task 17-equivalent / finish): fidelity, reference and visual baselines not run; templates/conversation baseline will change — the user triggers visual-update / reference-update
Task 9: fix round 1/5 (6 addressed, 0 open; commits 1ca993f4..91b673f4)
Task 9: complete (commits 1aa9c52e..91b673f4, review clean)
Task 9: minor (deferred to the final review): the agent panel stays two columns on phones (no narrow rule; AGENT_PANEL_COLUMNS would have to follow)
Task 10: complete (commits 91b673f4..7765b32f, review clean)
Task 10: minor (deferred): sidebar avatars wait for a cached agents query (follow-up: kernel adds avatar to groups' agent); ordering ignores archived and beyond-first-page groups; avatar forms in title bar / sidebar / object row have no /dev/ui reference block or size row; native undo stack after the one-step buffer varies by browser; e2e placeholder wait couples to the "—" fallback

Final review (opus) of 92ac336d..7765b32f: Ready to merge — yes with fixes. Fix wave: I1 attachments(agent_id) partial index migration; M1 Avatar img referrerPolicy no-referrer + spec note "avatar route redirects (302 https) rather than proxies"; M2 changeset line (PATCH without instructions keeps the prompt); /dev/ui blocks + size rows for PageHeader avatar slot, title-bar/sidebar/object-row avatars, initials at 24. Other deferred minors → follow-up (triage in review report).
Ruling: avatar route redirects instead of proxying external images — no bytes through the kernel, https-only, no open redirect since external comes only from migration — cost if wrong: an external host sees viewers' IPs (Referer suppressed by no-referrer).
