---
"@capybara-hq/web": patch
---

The guided setup layout takes the shell's shape: the design system's `SetupPage` is now the sidebar,
the content area and the status bar, with the sidebar in a new setup context whose navigation is
"开始之前" and the setup steps (each with a done, to-do or waiting mark and, while waiting, the
reason), the optional steps under "可以稍后再做"; the rail and the drawer work as in the shell. Design
links show a 2 px accent underline while their navigation is pending (`DesignProvider`
`useLinkPending`, fed from next/link's `useLinkStatus`).
