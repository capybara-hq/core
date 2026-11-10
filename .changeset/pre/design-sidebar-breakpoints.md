---
"@capybara-hq/design": patch
---

The sidebar's breakpoints are exported once (`SIDEBAR_RAIL_QUERY`, `SIDEBAR_DRAWER_QUERY`), and the
App Shell's `sidebar=` state token reads them through the sidebar instead of repeating the widths.
