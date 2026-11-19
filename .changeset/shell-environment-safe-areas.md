---
"@capybara-hq/web": minor
---

Safe areas, foreground resume and the Shell environment: the root layout declares the viewport
(`viewport-fit=cover`, `interactive-widget=resizes-content`, a theme color per scheme) and renders
the Shell environment script first in `<head>` with the request's CSP nonce; the design's
`--cb-inset-*` tokens combine the OS safe areas with a native shell's insets; the AppShell follows
the shell's `change`, adds the `shell=` state token and tells `chrome@1` the theme; `lib/shell.ts`
reads shell capabilities by `name@major` (event-handler accessor refused during a render); a
conversation stream dropped in the background reopens from the cached last seq on return.
