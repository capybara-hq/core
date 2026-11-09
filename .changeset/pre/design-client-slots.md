---
"@capybara-hq/design": patch
---

`Sidebar` takes `brand` as a function of the panel it is drawn in (`{ collapsed, panel: "full" |
"rail" | "drawer" }`), called once per drawn panel. `ReplaceableFrame` takes a `ref`, and a pending
frame is revealed by CSS alone after 1 500 ms (no `inert` / `aria-hidden`: `visibility` already takes
hidden content out of focus and the accessibility tree), so a pending frame the server drew never
stays hidden.
