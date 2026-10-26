// Reference set renderer (docs/design/reference/README.md). Not product code: it draws the target
// design from the shared fixtures so every page uses the same copy and counts.
//
// - `?theme=dark|light` sets <html data-theme>.
// - `<template data-fixture="kind" data-opts='{…}'>` is replaced by the markup RENDER[kind] builds
//   from window.__CB_FIXTURES__ (@capybara-hq/design/fixtures).
// - `<i data-icon="name" data-size="16">` becomes the icon's SVG from window.__CB_ICONS__
//   (ICON_PATHS: the 24-grid child elements; stroke 1.5).
// - Pseudo-states are drawn with data-state="hover|focus|…", never with real hover.
(() => {
  const theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;

  const F = window.__CB_FIXTURES__;
  const ICONS = window.__CB_ICONS__;
  if (!F || !ICONS) {
    document.body.dataset.error = "fixtures or icons were not injected";
    throw new Error("window.__CB_FIXTURES__ / __CB_ICONS__ missing: render through apps/web/reference");
  }

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, size = 16) => `<i data-icon="${name}" data-size="${size}"></i>`;
  const state = (s) => (s ? ` data-state="${s}"` : "");
  /** "2026-10-20T14:32:00+08:00" -> "10-20 14:32" */
  const stamp = (iso) => `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
  const LOGO =
    '<svg class="r-logo" width="28" height="20" viewBox="0 0 14 10" shape-rendering="crispEdges" aria-hidden="true"><path d="M10 0h1v1h-1zM9 1h3v1h-3zM3 2h11v1h-11zM2 3h9v1h-9zM12 3h2v1h-2zM1 4h13v1h-13zM1 5h13v1h-13zM1 6h12v1h-12zM2 7h10v1h-10zM2 8h2v1h-2zM6 8h1v1h-1zM9 8h2v1h-2zM2 9h2v1h-2zM6 9h1v1h-1zM9 9h2v1h-2z"/></svg>';

  const VISIBLE = {
    guest: ["all"],
    member: ["all", "member"],
    admin: ["all", "member", "admin"],
    enterprise: ["all", "member", "admin", "enterprise"],
  };

  // ── Sidebar ───────────────────────────────────────────────────────────────

  function navItem(n, o) {
    const current = n.id === o.active ? ' aria-current="page"' : "";
    const st = o.hover === n.id ? "hover" : o.focus === n.id ? "focus" : "";
    const count =
      n.count !== undefined
        ? `<span class="r-nav-count" aria-hidden="true">${n.count}</span>`
        : "";
    const label = n.count !== undefined ? `${n.label}，${n.count} 项待处理` : n.label;
    if (o.mode === "rail") {
      const badge = n.count !== undefined ? `<span class="r-rail-badge">${n.count}</span>` : "";
      return `<a class="r-nav-item r-rail-item" href="#" aria-label="${esc(label)}"${current}${state(st)}>${icon(n.icon)}${badge}</a>`;
    }
    return `<a class="r-nav-item" href="#" aria-label="${esc(label)}"${current}${state(st)}>${icon(n.icon)}<span class="r-ellipsis">${esc(n.label)}</span>${count}</a>`;
  }

  function convRow(c, o) {
    const untitled = c.title === null;
    const text = untitled ? `${F.UNTITLED_CONVERSATION} · ${stamp(c.startedAt)}` : c.title;
    const current = c.id === o.activeConversation ? ' aria-current="page"' : "";
    const st = o.hover === c.id ? "hover" : o.focus === c.id ? "focus" : "";
    return `<a class="r-conv" href="#" title="${esc(text)}"${current}${state(st)}><span class="r-ellipsis">${esc(text)}</span></a>`;
  }

  function group(g, o) {
    const collapsed = (o.collapsed || []).includes(g.agentId);
    const head = `<div class="r-group-head"${state(o.hover === g.agentId ? "hover" : "")}>
      <button class="r-group-toggle" aria-expanded="${!collapsed}" title="${esc(g.agentName)}"><span class="r-ellipsis">${esc(g.agentName)}</span>${icon(collapsed ? "chevron-right" : "chevron-down", 12)}</button>
      <button class="r-icon-btn" data-step="dense" aria-label="${esc(F.SIDEBAR_COPY.newConversationIn)}：${esc(g.agentName)}">${icon("plus", 14)}</button>
    </div>`;
    if (collapsed) return `<div class="r-group">${head}</div>`;
    const more = g.more ? `<button class="r-conv r-conv-more">${esc(F.SIDEBAR_COPY.more)}</button>` : "";
    return `<div class="r-group">${head}${g.conversations.map((c) => convRow(c, o)).join("")}${more}</div>`;
  }

  function conversations(o) {
    if (o.state === "empty") return `<p class="r-sb-hint">${esc(F.SIDEBAR_COPY.empty)}</p>`;
    if (o.state === "loading") {
      const bars = [64, 88, 72, 0, 56, 80, 0, 60, 76]
        .map((w) =>
          w === 0
            ? '<span class="r-skel-gap"></span>'
            : `<span class="r-skel" style="width:${w}%"></span>`,
        )
        .join("");
      return `<div class="r-sb-loading" aria-busy="true" aria-label="加载中">${bars}</div>`;
    }
    if (o.state === "error") {
      return `<div class="r-sb-error" role="alert"><span class="r-fail-text">${icon("circle-alert", 14)}${esc(F.SIDEBAR_COPY.error)}</span><button class="r-btn" data-variant="ghost" data-step="dense">${icon("refresh", 14)}${esc(F.SIDEBAR_COPY.retry)}</button></div>`;
    }
    const groups =
      o.groups === "long"
        ? [F.LONG_TITLE_GROUP_FIXTURE, ...F.GROUPS_FIXTURE.slice(1)]
        : o.groups === "many"
          ? F.MANY_GROUPS_FIXTURE
          : F.GROUPS_FIXTURE;
    const moreGroups =
      o.groups === "many" && F.MANY_GROUPS_MORE
        ? `<button class="r-conv r-conv-more">${esc(F.SIDEBAR_COPY.moreGroups)}</button>`
        : "";
    return groups.map((g) => group(g, o)).join("") + moreGroups;
  }

  function sidebar(o) {
    const level = o.level || "enterprise";
    const visible = F.NAV_FIXTURE.filter((n) => VISIBLE[level].includes(n.audience));
    const main = visible.filter((n) => n.id !== "settings" && n.id !== "admin");
    const tail = visible.filter((n) => n.id === "settings" || n.id === "admin");
    const rail = o.mode === "rail";
    const ext = F.EXTENSION_PAGES_FIXTURE.map((p) =>
      navItem({ id: p.id, label: p.label, icon: "extension" }, o),
    ).join("");
    const top = rail
      ? `<div class="r-sb-top">${LOGO}</div>
         <button class="r-icon-btn r-rail-item" aria-label="${esc(F.SIDEBAR_COPY.expand)}">${icon("panel-left")}</button>
         <button class="r-icon-btn r-rail-item" aria-label="${esc(F.SIDEBAR_COPY.search)}">${icon("search")}</button>`
      : `<div class="r-sb-top">${LOGO}<span class="r-wordmark">CAPYBARA</span>
          <button class="r-icon-btn" aria-label="${esc(F.SIDEBAR_COPY.search)} ${esc(F.SIDEBAR_COPY.searchShortcut)}">${icon(o.mode === "drawer" ? "x" : "search")}</button></div>`;
    const newConv = navItem({ id: "new", label: F.NEW_CONVERSATION_LABEL, icon: "plus" }, o).replace(
      'class="r-nav-item',
      'class="r-nav-item r-nav-new',
    );
    const extGroup =
      F.EXTENSION_PAGES_FIXTURE.length === 0
        ? ""
        : rail
          ? `<span class="r-rail-sep"></span>${ext}`
          : `<div class="r-sb-label">${esc(F.EXTENSIONS_LABEL)}</div>${ext}`;
    const nav = `<nav class="r-sb-nav" aria-label="主导航">${newConv}${main.map((n) => navItem(n, o)).join("")}${extGroup}${rail ? '<span class="r-rail-sep"></span>' : '<span class="r-sb-gap"></span>'}${tail.map((n) => navItem(n, o)).join("")}</nav>`;
    const convs = rail ? "" : `<div class="r-sb-convs" aria-label="会话">${conversations(o)}</div>`;
    const foot = rail
      ? `<div class="r-sb-foot"><span class="r-avatar" title="${esc(F.SIDEBAR_COPY.account)}">${F.FIXTURE_USER.initial}</span></div>`
      : `<div class="r-sb-foot"><span class="r-avatar">${F.FIXTURE_USER.initial}</span><span class="r-ellipsis">${esc(F.SIDEBAR_COPY.account)}</span></div>`;
    return `<aside class="r-sidebar" data-mode="${o.mode || "full"}">${top}${nav}${convs}${foot}</aside>`;
  }

  // ── Page header, stat cards, status bar, action row ──────────────────────

  function pageHeader(o) {
    const L = F.LIST_PAGE_FIXTURE;
    const title = o.title || L.title;
    const crumb = o.breadcrumb
      ? `<nav class="r-ph-crumb" aria-label="面包屑">${F.FORM_PAGE_FIXTURE.breadcrumb
          .map((c) => (c.href ? `<a href="#">${esc(c.label)}</a>` : `<span>${esc(c.label)}</span>`))
          .join('<span class="r-faint" aria-hidden="true">/</span>')}</nav>`
      : "";
    const desc = o.description ? `<p class="r-ph-desc">${esc(L.description)}</p>` : "";
    const actions = o.actions
      ? `<div class="r-ph-actions"><button class="r-btn" data-variant="default">${esc(L.secondaryAction)}</button><button class="r-btn" data-variant="primary">${icon("plus", 14)}${esc(L.primaryAction)}</button></div>`
      : "";
    return `<header class="r-ph">${crumb}<div class="r-ph-row"><div class="r-ph-text"><h1 class="r-ph-title" title="${esc(title)}">${esc(title)}</h1>${desc}</div>${actions}</div></header>`;
  }

  function stats(o) {
    const metrics = o.five ? F.LIST_PAGE_FIXTURE.metricsFive : F.LIST_PAGE_FIXTURE.metrics;
    return `<div class="r-stats">${metrics
      .map(
        (m) =>
          `<div class="r-stat"><div class="r-stat-label">${esc(m.label)}</div><div class="r-stat-value"${m.tone ? ` data-tone="${m.tone}"` : ""}>${esc(m.value)}</div></div>`,
      )
      .join("")}</div>`;
  }

  function statusBar(o) {
    const S = F.STATUS_FIXTURE;
    const context = o.context || S.context;
    const page = o.noPageStatus ? "" : o.pageStatus || S.pageStatus;
    const pageSpan = page ? `<span class="r-ellipsis">${esc(page)}</span>` : "";
    return `<footer class="r-status" role="status"><div class="r-status-left"><span class="r-ellipsis r-status-context">${esc(context)}</span>${pageSpan}</div><div class="r-status-right"><span>${esc(S.system)}</span><span>${esc(S.version)}</span><span>${esc(S.timeZone)}</span></div></footer>`;
  }

  function actionRow(o) {
    const A = F.FORM_PAGE_FIXTURE.actionRow;
    if (o.clean) {
      return `<div class="r-actionrow"><span class="r-actionrow-text">${esc(A.clean)}</span><button class="r-btn" data-variant="primary" disabled>${esc(A.save)}</button></div>`;
    }
    return `<div class="r-actionrow"><span class="r-dot" aria-hidden="true"></span><span class="r-actionrow-text">${esc(A.unsaved)} · <span class="r-fail-text">${esc(A.errors)}</span></span><button class="r-btn" data-variant="default">${esc(A.discard)}</button><button class="r-btn" data-variant="primary">${esc(A.save)}</button></div>`;
  }

  // ── Table ────────────────────────────────────────────────────────────────

  const STATUS_ICON = { "needs-auth": "circle-alert", error: "circle-x", disabled: "ban" };

  function statusCell(s) {
    const label = F.CONNECTOR_STATUS_LABEL[s];
    const ic = STATUS_ICON[s] ? icon(STATUS_ICON[s], 12) : "";
    return `<span class="r-cell-status" data-status="${s}">${ic}${esc(label)}</span>`;
  }

  function table(o) {
    const L = F.LIST_PAGE_FIXTURE;
    const C = L.columns;
    const head = `<thead><tr><th>${esc(C.name)}</th><th>${esc(C.type)}</th><th>${esc(C.status)}</th><th class="r-num">${esc(C.tools)}</th><th class="r-num">${esc(C.calls7d)}</th><th>${esc(C.owner)}</th><th class="r-col-act"><span class="r-sr">${esc(L.rowActions)}</span></th></tr></thead>`;
    let body;
    if (o.state === "loading") {
      body = [52, 40, 60, 44, 36]
        .map(
          (w) =>
            `<tr class="r-row-skel"><td colspan="7"><span class="r-skel" style="width:${w}%"></span></td></tr>`,
        )
        .join("");
      return `<div class="r-table" aria-busy="true"><table>${head}<tbody>${body}</tbody></table></div>`;
    }
    if (o.state === "empty") {
      body = `<tr><td colspan="7" class="r-table-empty"><div>${icon("empty", 16)}<span>${esc(L.empty.title)}</span><button class="r-btn" data-variant="default">${esc(L.empty.action)}</button></div></td></tr>`;
      return `<div class="r-table"><table>${head}<tbody>${body}</tbody></table></div>`;
    }
    const rows = (o.rows ? L.rows.slice(0, o.rows) : L.rows).map((r) => {
      const st =
        o.hoverRow && r.id === F.TABLE_HOVER_ROW
          ? ' data-state="hover"'
          : o.selectedRow && r.id === F.TABLE_SELECTED_ROW
            ? ' aria-selected="true"'
            : "";
      return `<tr${st}><td><div class="r-cell-name"><span class="r-initial" aria-hidden="true">${esc(r.name.slice(0, 1))}</span><div class="r-min0"><div class="r-ellipsis">${esc(r.name)}</div><div class="r-cell-desc r-ellipsis">${esc(r.description)}</div></div></div></td><td class="r-muted">${r.type}</td><td>${statusCell(r.status)}</td><td class="r-num">${r.tools}</td><td class="r-num r-muted">${esc(r.calls7d)}</td><td class="r-muted">${esc(r.owner)}</td><td class="r-col-act"><button class="r-icon-btn" data-step="dense" aria-label="${esc(L.rowActions)}">${icon("more-horizontal", 14)}</button></td></tr>`;
    });
    return `<div class="r-table"><table>${head}<tbody>${rows.join("")}</tbody></table></div>`;
  }

  function toolbar() {
    const L = F.LIST_PAGE_FIXTURE;
    const chips = L.chips
      .map(
        (c, i) =>
          `<button class="r-chip" aria-pressed="${i === 0}">${esc(c.label)}<span class="r-chip-count">${c.count}</span></button>`,
      )
      .join("");
    return `<div class="r-toolbar"><label class="r-search">${icon("search", 14)}<span class="r-sr">${esc(L.searchPlaceholder)}</span><input placeholder="${esc(L.searchPlaceholder)}"></label>${chips}<span class="r-toolbar-sort">${esc(L.sort)}</span></div>`;
  }

  function pagination() {
    return `<div class="r-pagination"><span>${esc(F.LIST_PAGE_FIXTURE.pagination)}</span><button class="r-icon-btn" data-variant="default" data-step="dense" aria-label="上一页" disabled>${icon("chevron-left", 14)}</button><button class="r-icon-btn" data-variant="default" data-step="dense" aria-label="下一页">${icon("chevron-right", 14)}</button></div>`;
  }

  // ── Form ─────────────────────────────────────────────────────────────────

  function field(f) {
    const opt = f.optional ? ' <span class="r-faint">选填</span>' : "";
    switch (f.kind) {
      case "input":
        return `<div class="r-field"><label class="r-label" for="f-${f.id}">${esc(f.label)}${opt}</label><input class="r-input" id="f-${f.id}" value="${esc(f.value)}"${f.error ? ' aria-invalid="true" data-state="error"' : ""}>${f.error ? `<span class="r-field-error">${icon("circle-alert", 12)}${esc(f.error)}</span>` : ""}</div>`;
      case "textarea":
        return `<div class="r-field"><label class="r-label" for="f-${f.id}">${esc(f.label)}${opt}</label><textarea class="r-input r-textarea${f.mono ? "" : " r-prose-input"}" id="f-${f.id}" rows="${f.mono ? 4 : 2}"${f.focus ? ' data-state="focus"' : ""}>${esc(f.value)}</textarea>${f.counter ? `<span class="r-field-counter">${esc(f.counter)}</span>` : ""}</div>`;
      case "select":
        return `<div class="r-field"><label class="r-label" for="f-${f.id}">${esc(f.label)}</label><div class="r-select"><select class="r-input" id="f-${f.id}"><option>${esc(f.value)}</option></select>${icon("chevron-down", 14)}</div></div>`;
      case "segmented":
        return `<div class="r-field"><span class="r-label">${esc(f.label)}</span><div class="r-seg r-seg-fill" role="radiogroup" aria-label="${esc(f.label)}">${f.options
          .map((x, i) => `<button role="radio" aria-checked="${i === f.selected}">${esc(x)}</button>`)
          .join("")}</div></div>`;
      case "switches":
        return `<div class="r-switch-list">${f.rows
          .map(
            (r) =>
              `<div class="r-switch-row"><div class="r-min0"><div class="r-ellipsis">${esc(r.name)}</div><div class="r-cell-desc">${esc(r.description)}</div></div><span class="r-muted r-small">${esc(r.policy)}</span><button class="r-switch" role="switch" aria-checked="${r.on}" aria-label="${esc(r.name)}"><span></span></button></div>`,
          )
          .join("")}</div>`;
    }
    return "";
  }

  function formSections() {
    return F.FORM_PAGE_FIXTURE.sections
      .map((s) => {
        const pairs = [];
        const fields = s.fields.map(field);
        // The model select and the effort control share a row (canvas FormPage).
        if (s.fields[0]?.kind === "select" && s.fields[1]?.kind === "segmented") {
          pairs.push(`<div class="r-field-pair">${fields[0]}${fields[1]}</div>`, ...fields.slice(2));
        } else pairs.push(...fields);
        const flush = s.fields[0]?.kind === "switches" ? " r-form-card-flush" : "";
        return `<section class="r-form-section"><div class="r-form-intro"><h2 class="r-h2">${esc(s.title)}</h2><p class="r-prose-small r-muted">${esc(s.description)}</p></div><div class="r-form-card${flush}">${pairs.join("")}</div></section>`;
      })
      .join("");
  }

  // ── Templates ────────────────────────────────────────────────────────────

  function listPage() {
    return `<div class="r-app">${sidebar({ active: "connectors", activeConversation: null })}<main class="r-main"><div class="r-main-scroll"><div class="r-content" data-width="list">${pageHeader({ description: true, actions: true })}${stats({})}${toolbar()}${table({})}${pagination()}</div></div>${statusBar({})}</main></div>`;
  }

  function formPage() {
    const P = F.FORM_PAGE_FIXTURE;
    return `<div class="r-app">${sidebar({ active: "agents", activeConversation: null })}<main class="r-main"><div class="r-main-scroll"><div class="r-content" data-width="form">${pageHeader({ breadcrumb: true, title: P.title })}${formSections()}</div></div>${actionRow({})}${statusBar({ context: P.status.context, pageStatus: P.status.pageStatus })}</main></div>`;
  }

  function drawer(o) {
    return `<div class="r-drawer-stage"><div class="r-drawer-page"><div class="r-drawer-bar"><button class="r-icon-btn" aria-label="${esc(F.SIDEBAR_COPY.menu)}" aria-expanded="true">${icon("menu")}</button><span class="r-ellipsis">${esc(F.LIST_PAGE_FIXTURE.title)}</span></div><div class="r-drawer-body">${pageHeader({ description: true })}${stats({})}</div>${statusBar({ noPageStatus: true })}</div><div class="r-scrim"></div><div class="r-drawer" role="dialog" aria-modal="true" aria-label="导航">${sidebar({ ...o, mode: "drawer" })}</div></div>`;
  }

  function rail(o) {
    const tip = o.tooltip
      ? `<span class="r-tooltip" role="tooltip" style="top:${o.tooltipTop}px">${esc(o.tooltip)}</span>`
      : "";
    return `<div class="r-rail-stage">${sidebar({ ...o, mode: "rail" })}${tip}</div>`;
  }

  function iconGrid(o) {
    return `<div class="r-icon-grid">${Object.keys(ICONS)
      .map((n) => `<div class="r-icon-cell">${icon(n, o.size)}<span>${n}</span></div>`)
      .join("")}</div>`;
  }

  const RENDER = {
    sidebar,
    rail,
    drawer,
    "page-header": pageHeader,
    stats,
    "status-bar": statusBar,
    "action-row": actionRow,
    table,
    toolbar,
    pagination,
    "form-sections": formSections,
    "list-page": listPage,
    "form-page": formPage,
    "icon-grid": iconGrid,
  };

  for (const t of document.querySelectorAll("template[data-fixture]")) {
    const kind = t.dataset.fixture;
    if (!RENDER[kind]) throw new Error(`unknown fixture kind ${kind}`);
    const opts = t.dataset.opts ? JSON.parse(t.dataset.opts) : {};
    const box = document.createElement("div");
    box.innerHTML = RENDER[kind](opts);
    t.replaceWith(...box.childNodes);
  }

  for (const el of document.querySelectorAll("i[data-icon]")) {
    const name = el.dataset.icon;
    const size = Number(el.dataset.size || 16);
    const paths = ICONS[name];
    if (!paths) throw new Error(`unknown icon ${name}`);
    const svg = `<svg class="cb-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.join("")}</svg>`;
    el.insertAdjacentHTML("afterend", svg);
    el.remove();
  }

  // Block captions (outside the screenshotted section) for people browsing the page.
  for (const b of document.querySelectorAll("[data-ref-block]")) {
    const fig = document.createElement("figure");
    fig.className = "r-figure";
    const cap = document.createElement("figcaption");
    cap.textContent = b.dataset.refBlock;
    b.before(fig);
    fig.append(cap, b);
  }
  document.body.dataset.ready = "1";
})();
