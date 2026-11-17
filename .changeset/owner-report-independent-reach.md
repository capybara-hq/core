---
"@capybara-hq/kernel": minor
---

Persist authenticated device owner reports (migration 0147, `device_machines.owner_report`) through
one owner writer fed by the staged v3 hello, policy frame, applied policy answers and statuses and
the bind answer: a higher sequence is recorded, the same report is idempotent, a lower or
conflicting one blocks new authority (`device.owner_report_stale`) until a valid current report.
Full permission and restricted project reach are now independent: preview, browse admission,
selected-project binding and directory expansions use the reach within the platform and org
ceiling, Full execution uses Full permission. Restricted-only owner changes keep Full consent and
Full work; removing Full revokes only Full work and resets consent. The device read view gains
`ownerCeiling`; the local policy route accepts only an owner-ceiling narrowing (sent only to
programs that report owner facts); the cloud device PATCH takes `ownerCeiling: {fullAccess}` with
explicit confirmation for widening, session only. Protocol 2 summaries keep translating exactly.
