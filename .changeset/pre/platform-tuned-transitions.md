---
"@capybara-hq/web": patch
---

Push and pop slides use the platform's navigation timing (350ms iOS curve; 300ms Material
emphasized under `data-shell-platform="android"`), with the page underneath parallaxed and dimmed
on the way back. A back gesture the browser already animated (`hasUAVisualTransition`) swaps at
once, and tab switches (including the native tab bar's) never slide. A lost Space keyup on a
native menu trigger no longer swallows the next tap, and a native tab bar whose handle goes away
while the shell stays is hidden.
