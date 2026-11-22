---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/plugin-client": patch
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

The composer exposes its pieces as UI parts: `composer.box` (the text with ＋ and send; the
floating pill in the mobile form, `:focus-within` while one of them has focus, never for the control
row), `composer.options` (the mobile settings chip) and `composer.send` (send, and stop in its
place). The pill is now that real element instead of the frame's `::before`, so a theme's frame,
corners and run effects can follow it without enclosing the chip row; the control row sits outside
it (the DOM order is the text, ＋, send, then the row). In the mobile form send keeps its place at
the pill's end when the agent picker above it is wider. `Button` and `IconButton` let a caller's
`data-cap-part` name the control too.
