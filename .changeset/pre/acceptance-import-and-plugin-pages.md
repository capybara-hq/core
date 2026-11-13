---
"@capybara-hq/capybara": patch
"@capybara-hq/plugin-client": patch
---

A confirmed plugin import stops reading the staging it consumed (the error card that flashed before
the navigation landed); an extension component asks for its view after mount, not from its render;
a one-page plugin is addressed at `/p/<plugin>` and extension pages draw no single-tab bar; the
client API forwards the design system's `Select`, so a client component offers a plugin's choices
in the product's own dropdown rather than the browser's.
