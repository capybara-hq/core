# Task 10 Slice B review (f0584546f vs a5185eb77)

Verdict: APPROVE (no Critical or Important findings; 3 Minor)

Verification: `pnpm exec vitest run apps/web/test packages/design/test` (workers 4): 278 files, 5052 tests passed.
`pnpm check:web-ui` passed; `pnpm check:i18n` passed.

## Checked and found sound
- apps/web writes no styles: no className/style in apps/web src diff; all CSS in packages/design (conversation-page.css, tokens only).
- Component change flow followed: spec.md (§6.16.3 slot order, picker-menu state `permission`, size rows), dev catalog (conversation-page-blocks), reference set (picker-menu.html, conversation.js, reference.css), fixtures, design tests, changeset.
- Neutral treatment: all three rows use the same DescribedItem / options-item markup; icon color muted, no tone/badge/accent for Full access; test compares row classes. Only Full access gets a `tag` and only when unavailable (reason text), same slot as other disabled rows.
- Consent (usePermissionChoice): consent holds {deviceId, project, scopeRevision}; render-time reset to approve-for-me on device/project/revision change; dialog freezes the previewed state and `confirm` re-checks device/project/revision; Full is selectable only via dialog. Selection carries consentScopeRevision only with consent.
- Owner-only reads: ConversationView `enabled: owner` (accountId match; unknown row = no read), no picker for viewers; test asserts zero /permissions calls for a viewer. Prefetch in query/conversation.ts:452 is owner-gated identically.
- Accessibility: described items get aria-labelledby (label + tag) and aria-describedby (description) in both the menu (menuitemradio/option) and phone radio sheet; native radios keep keyboard behavior; disabled rows retain a reason tag.
- Scope: nothing from Slices C-E leaked. No first-send change, no PATCH, mode pickers untouched; new conversation shows the locked default only; usePermissionChoice is exported and tested but not mounted in product (read-only as planned).
- Copy: en/zh parallel, zh uses 智能体-safe wording (no Latin agent, no 企业); the note "Changes apply to new operations..." and "not root access" caveat are accurate and calm.
- Edited pre-existing assertions are justified, not weakened: conversation-page.test and right-area.test replaced "no locked picker" with an exact-equality check that the only locked picker is the permission value (stricter, still proves no locked agent/device picker); permissions refresh count 1->2 reflects the page's own owner read on mount plus the explicit refresh, and the cache assertion after is unchanged.

## Findings

### Minor 1: extra owner GET and late appearance on empty-cache client navigation
ConversationView.tsx:~268. With a cold cache the permissions query is enabled only after the conversation row loads (needs accountId), so it is a second sequential request and the picker appears after the composer. Acceptable under the skill's rules (prefetch covers the known-row case via conversation.ts:452; the in-page `useQuery` with retryOnMount is the sanctioned fallback) and the picker slot is read-only, so there is no layout-critical dependence. Optional: none required. Note the row-unknown waterfall in the PR description.

### Minor 2: `initial` only seeds state on mount
PermissionPicker.tsx (usePermissionChoice, `useState({profile: input.initial ?? default})`). If the recorded profile arrives after mount, the choice stays at the default. Not reachable now (hook unmounted), but Slice C/D wiring must key the hook on the conversation or sync once the recorded profile loads. Fix: in C, mount only after the permissions read resolves or add a reset keyed by revision.

### Minor 3: spec size-table rows interleaved
docs/design/spec.md (picker-menu size table): the new `permission` rows are inserted between `menu-note | model | color` and `menu-note | model | border-top-color`, splitting the model block. Cosmetic; move the permission rows after the model/effort rows if check tooling does not require order.
