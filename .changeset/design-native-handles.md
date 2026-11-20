---
"@capybara-hq/web": minor
---

Design native handles for the mobile app: `DesignProvider` takes `native` handlers (menu, share,
haptics) and `AppShell` a `nativeNav` tab bar handle with `onNavigate`. Inside a shell with
`nav@1` the web's bottom navigation is dropped before the first paint (`data-native-nav`) and the
native bar is told the items, the current tab and when it belongs on screen. Plain menus open as
the platform's action sheet on phones, sends, approvals, destructive confirmations and selection
changes play haptics, and `ShellReady` tells `chrome@1` the page has drawn.
