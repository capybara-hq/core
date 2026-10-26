// Writes docs/design/reference/index.html: the static review page of the reference set (every
// block, dark and light side by side, with its name) plus the color tokens from tokens.json.
// Run after the renderer (`pnpm --filter @capybara-hq/web reference:render` does both).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../../docs/design/reference/", import.meta.url));
const tokens = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../docs/design/tokens.json", import.meta.url)), "utf8"),
);
// Component order of the review page; a block's component is the longest matching prefix.
const COMPONENTS = [
  "template-list",
  "template-form",
  "sidebar",
  "page-header",
  "stat-cards",
  "status-bar",
  "action-row",
  "button",
  "input",
  "segmented",
  "switch",
  "filter-chip",
  "table",
  "icon",
];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const blocks = [
  ...new Set(
    readdirSync(dir)
      .filter((f) => /-(dark|light)\.png$/.test(f))
      .map((f) => f.replace(/-(dark|light)\.png$/, "")),
  ),
].sort();
const componentOf = (id) =>
  COMPONENTS.filter((c) => id.startsWith(`${c}-`)).sort((a, b) => b.length - a.length)[0] ??
  "other";

const sections = [...COMPONENTS, "other"]
  .map((c) => {
    const ids = blocks.filter((b) => componentOf(b) === c);
    if (ids.length === 0) return "";
    const rows = ids
      .map(
        (id) => `<figure id="${id}">
  <figcaption><a href="#${id}">${id}</a></figcaption>
  <div class="pair">
    <div class="shot dark"><img src="${id}-dark.png" alt="${id}, dark" loading="lazy"></div>
    <div class="shot light"><img src="${id}-light.png" alt="${id}, light" loading="lazy"></div>
  </div>
</figure>`,
      )
      .join("\n");
    return `<section><h2 id="c-${c}">${c} <small>${ids.length} blocks</small></h2>\n${rows}</section>`;
  })
  .join("\n");

const nav = COMPONENTS.filter((c) => blocks.some((b) => componentOf(b) === c))
  .map((c) => `<a href="#c-${c}">${c}</a>`)
  .join(" ");

const swatch = (v) =>
  v.startsWith("#") || v.startsWith("rgba")
    ? `<span class="sw" style="background:${v}"></span>`
    : "";
const colorRows = Object.entries({ ...tokens.color, ...tokens.shadow })
  .map(
    ([name, t]) =>
      `<tr><td><code>${name}</code></td><td>${swatch(t.dark)}<code>${esc(t.dark)}</code></td><td>${swatch(t.light)}<code>${esc(t.light)}</code></td><td>${esc(t.purpose)}</td></tr>`,
  )
  .join("\n");
const sizeRows = Object.entries(tokens.size)
  .map(
    ([g, steps]) =>
      `<tr><td><code>${g}</code></td><td>${Object.entries(steps)
        .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join("/") : v}`)
        .join(" · ")}</td></tr>`,
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reference set review</title>
<style>
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #1b1b1a; color: #e6e6e3; }
  header, main { padding: 16px 24px; }
  header { position: sticky; top: 0; background: #1b1b1af0; border-bottom: 1px solid #333; z-index: 1; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header nav a { color: #ff8240; margin-right: 10px; font-size: 13px; }
  h2, figure { scroll-margin-top: 110px; }
  h2 { margin: 32px 0 12px; font-size: 16px; border-bottom: 1px solid #333; padding-bottom: 6px; }
  h2 small { color: #8e8e89; font-weight: 400; }
  figure { margin: 0 0 24px; }
  figcaption { margin-bottom: 6px; font-family: ui-monospace, monospace; }
  figcaption a { color: #e6e6e3; text-decoration: none; }
  .pair { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
  .shot { padding: 8px; border-radius: 4px; max-width: 100%; overflow: auto; }
  .shot.dark { background: #0a0a0a; } .shot.light { background: #f7f6f2; }
  .shot img { display: block; width: auto; max-width: 100%; zoom: 0.5; }
  table { border-collapse: collapse; font-size: 13px; }
  td, th { padding: 4px 10px; border-bottom: 1px solid #333; text-align: left; vertical-align: middle; }
  code { font-family: ui-monospace, monospace; }
  .sw { display: inline-block; width: 14px; height: 14px; border: 1px solid #555; vertical-align: middle; margin-right: 6px; }
  details { margin: 12px 0; }
</style>
</head>
<body>
<header>
  <h1>Reference set review</h1>
  <div>${blocks.length} blocks × dark | light, rendered at 2× from docs/design/reference/src (sizes are token steps of docs/design/tokens.json).</div>
  <nav>${nav} <a href="#tokens">tokens</a></nav>
</header>
<main>
${sections}
<section id="tokens">
<h2>Tokens (docs/design/tokens.json)</h2>
<details open><summary>Colors and shadows</summary>
<table><tr><th>Token</th><th>Dark</th><th>Light</th><th>Purpose</th></tr>
${colorRows}
</table></details>
<details open><summary>Size scales (px)</summary>
<table>${sizeRows}</table></details>
</section>
</main>
</body>
</html>
`;
writeFileSync(`${dir}index.html`, html);
console.log(`wrote docs/design/reference/index.html (${blocks.length} blocks)`);
