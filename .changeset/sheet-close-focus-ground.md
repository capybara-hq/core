---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

One bottom sheet look (spec §6.59, maintainer decision 2026-11-22): a 52 high head with no
hairline, the title centred and a 30 px round close on a fixed ground at the body's 14 px inset,
its 44 px hit area an invisible ring, so nothing paints on open; shared body parts (`SheetGroup`,
`SheetRow`, `SheetFootnote`). The account sheet is regrouped: a profile row that opens Personal
settings, 组织 with the current org (a menu with several), 语言 and 外观, sign out alone, the
status line as a footnote. `AccountSheetData` takes `orgMenu`, `language: { value, label, items }`
and the theme switch's data instead of slots.
