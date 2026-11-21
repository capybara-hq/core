---
"@capybara-hq/web": minor
---

Touch components in the design system: `FloatingIconButton` (the chat-first shell's round menu and
back button with a count badge), `Drawer` and `DrawerLevel` (a panel from the start edge, drag to
close, a deeper level), `NavRow`, large list rows without dividers or a card border on touch, and the
bottom sheet's touch form. Opening a drawer or a bottom sheet on a compact touch window holds one
history entry, so the system back closes it first (`useOverlayHistory`).
