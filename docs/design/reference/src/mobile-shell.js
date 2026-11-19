// Mobile-layout renderers of the reference set (design spec §6.45–§6.48, §6.7 sheet drag states).
// Loaded before fill.js, which merges them into its RENDER table: window.__CB_EXTRA__(helpers)
// returns { kind: (opts) => html }. Not product code: it draws the target design from
// BOTTOM_NAV_FIXTURE, TOP_BAR_FIXTURE, ME_PANEL_FIXTURE, LIST_DETAIL_FIXTURE and SHEET_FIXTURE
// (@capybara-hq/design/fixtures). Every size is a token step (reference.css, "Mobile layout").
window.__CB_EXTRA__ = ({ F, esc, icon, table }) => {
  const B = F.BOTTOM_NAV_FIXTURE;
  const T = F.TOP_BAR_FIXTURE;
  const M = F.ME_PANEL_FIXTURE;
  const L = F.LIST_DETAIL_FIXTURE;
  const S = F.SHEET_FIXTURE;

  // ── BottomNav (§6.45) ────────────────────────────────────────────────────

  function bottomNav(o) {
    const current = o.current ?? "chats";
    const items = B.items
      .map((n) => {
        const count = o.badge && n.count !== undefined ? n.count : undefined;
        const text = count > B.countMax ? `${B.countMax}+` : count;
        const label = count !== undefined ? `${n.label}，${text} 项待处理` : n.label;
        const badge =
          count !== undefined ? `<span class="r-nav-badge" data-part="item-badge">${text}</span>` : "";
        const name = o.short ? ` aria-label="${esc(label)}"` : "";
        return `<a class="r-bn-item" data-part="item" href="#"${name}${n.id === current ? ' aria-current="page"' : ""}><span class="r-badged">${icon(n.icon)}${badge}</span>${o.short ? "" : `<span class="r-bn-label" data-part="item-label">${esc(n.label)}</span>`}</a>`;
      })
      .join("");
    return `<nav class="r-bn" data-part="bottom-nav" aria-label="${esc(B.label)}"${o.short ? ' data-short="true"' : ""}>${items}</nav>`;
  }

  // ── TopBar (§6.46) ───────────────────────────────────────────────────────

  function topBar(o) {
    const pushed = o.pushed === true;
    const title = o.title ?? (pushed ? T.pushedTitle : T.rootTitle);
    const back = pushed
      ? `<button class="r-icon-btn r-tb-btn" data-part="back" aria-label="${esc(T.back)}">${icon("chevron-left")}</button>`
      : "";
    const more = `<button class="r-icon-btn r-tb-btn" data-part="more" aria-label="${esc(T.more)}" aria-haspopup="menu" aria-expanded="${o.overflow === true}"${o.overflow ? ' aria-pressed="true"' : ""}>${icon("more-horizontal")}</button>`;
    const bar = `<header class="r-tb" data-part="top-bar" data-pushed="${pushed}">${back}<h1 class="r-tb-title r-ellipsis" data-part="title">${esc(title)}</h1><button class="r-icon-btn r-tb-btn" data-part="search" aria-label="${esc(T.search)}">${icon("search")}</button>${more}</header>`;
    if (!o.overflow) return bar;
    const items = T.overflow
      .map((m, i) => {
        const sep = m.danger && i > 0 ? '<div class="r-menu-sep"></div>' : "";
        return `${sep}<a class="r-menu-item" role="menuitem" data-part="menu-item" href="#"${m.danger ? ' data-tone="fail"' : ""}>${icon(m.icon)}<span>${esc(m.label)}</span></a>`;
      })
      .join("");
    return `<div class="r-tb-stage">${bar}<div class="r-menu r-tb-menu" role="menu" aria-label="${esc(T.more)}">${items}</div></div>`;
  }

  // ── ListDetail (§6.47) ───────────────────────────────────────────────────

  function listRows(o) {
    return `<ul class="r-ld-list" data-part="list" aria-label="${esc(L.listTitle)}">${L.items
      .map((it, i) => {
        const current = o.current === it.id ? ' aria-current="true"' : "";
        const dot = it.state
          ? `<span class="r-ld-dot" data-state="${it.state}" role="img" aria-label="等待我"></span>`
          : '<span class="r-ld-dot" aria-hidden="true"></span>';
        return `<li class="r-ld-row" data-part="list-row"${current}>${dot}<span class="r-ld-text"><span class="r-ld-title r-ellipsis">${esc(it.title)}</span><span class="r-ld-meta r-ellipsis">${esc(it.meta)}</span></span><span class="r-ld-at">${esc(it.at)}</span></li>`;
      })
      .join("")}</ul>`;
  }

  function detailBody() {
    const D = L.detail;
    return `<div class="r-ld-body"><h2 class="r-ld-h">${esc(D.title)}</h2><dl class="r-ld-facts" data-part="facts">${D.facts
      .map(
        (f) =>
          `<dt class="r-ld-k" data-part="fact-key">${esc(f.label)}</dt><dd class="r-ld-v"${f.mono ? " data-mono" : ""}>${esc(f.value)}</dd>`,
      )
      .join("")}</dl></div>`;
  }

  function decisionButton(d, part) {
    return `<button class="r-btn" data-variant="${d.variant}" data-part="${part}">${esc(d.label)}</button>`;
  }

  // Compact (§4.4): the secondary decisions side by side on one line, the primary alone on the
  // full-width line under them. Two panes keep the ordinary ActionRow (primary rightmost).
  function decisionRow(o = {}) {
    const ds = L.detail.decisions;
    if (!o.compact) {
      return `<div class="r-actionrow r-ld-actions" data-part="decision-row"><span class="r-actionrow-text"></span>${ds
        .map((d) => decisionButton(d, d.variant === "primary" ? "decision-primary" : "decision-secondary"))
        .join("")}</div>`;
    }
    const primary = ds.filter((d) => d.variant === "primary");
    const others = ds.filter((d) => d.variant !== "primary");
    const line = (list, part) =>
      list.length ? `<div class="r-actionrow-line">${list.map((d) => decisionButton(d, part)).join("")}</div>` : "";
    return `<div class="r-actionrow r-ld-actions" data-part="decision-row" data-compact>${line(others, "decision-secondary")}${line(primary, "decision-primary")}</div>`;
  }

  function listDetail(o) {
    if (o.mode === "compact-list") {
      return `<div class="r-screen" data-part="screen">${topBar({ title: L.listTitle })}<div class="r-ld-scroll">${listRows({})}</div>${bottomNav({ current: "inbox", badge: true })}</div>`;
    }
    if (o.mode === "compact-detail") {
      // The detail is a pushed page: the top bar's back returns to the list, the bottom
      // navigation is hidden and the decision row is sticky at the bottom.
      return `<div class="r-screen" data-part="screen">${topBar({ pushed: true, title: L.detail.title })}<div class="r-ld-scroll">${detailBody()}</div>${decisionRow({ compact: true })}</div>`;
    }
    // two-pane: the list column (320) beside the detail (at least 360)
    return `<div class="r-ld-panes" data-part="list-detail" data-mode="two-pane"><div class="r-ld-listcol" data-part="list-pane">${listRows({ current: "ib1" })}</div><div class="r-ld-detailcol" data-part="detail-pane"><div class="r-ld-scroll">${detailBody()}</div>${decisionRow()}</div></div>`;
  }

  // ── MePanel (§6.48) ──────────────────────────────────────────────────────

  function meRow(it) {
    const trailing = it.value
      ? `<span class="r-me-value">${esc(it.value)}</span>`
      : it.id === "theme"
        ? `<span class="r-theme">${icon("sun", 12)}${icon("moon", 12)}</span>`
        : it.external
          ? icon("arrow-up-right", 14)
          : it.id === "sign-out"
            ? ""
            : icon("chevron-right", 12);
    const tag = it.id === "theme" || it.id === "language" || it.id === "sign-out" ? "button" : "a";
    const href = tag === "a" ? ' href="#"' : "";
    return `<${tag} class="r-me-row" data-part="row" data-id="${it.id}"${href}>${icon(it.icon)}<span class="r-ellipsis">${esc(it.label)}</span>${trailing}</${tag}>`;
  }

  function mePanel(o) {
    const role = o.role || "member";
    const visible = M.visible[role];
    const items = M.items.filter((n) => visible.includes(n.audience));
    // The admin console entry closes the manage group for super admins (whatever the org role).
    const admin =
      role === "super-admin"
        ? `<a class="r-me-row" data-part="admin-entry" data-id="admin" href="#">${icon(M.adminEntry.icon)}<span class="r-ellipsis">${esc(M.adminEntry.label)}</span>${icon("arrow-up-right", 14)}</a>`
        : "";
    // A group with no row draws nothing (a guest has no manage group).
    const group = (id, extra = "") => {
      const rows = items.filter((n) => n.group === id).map((n) => meRow(n)).join("") + extra;
      return rows
        ? `<section class="r-me-group" data-part="group" aria-label="${esc(M.groups[id])}"><h2 class="r-me-label" data-part="group-label">${esc(M.groups[id])}</h2>${rows}</section>`
        : "";
    };
    const A = M.adminContext;
    const inAdmin = o.context === "admin";
    // The super-admin block is an org member who is a super admin (the meta shows the org role).
    const orgRole = role === "admin" ? "组织管理员" : "组织成员";
    const org = inAdmin
      ? `<div class="r-sb-org r-me-org" data-static="true" data-part="context-block"><span class="r-sb-org-initial" data-tone="accent">${icon(A.block.icon, 14)}</span><span class="r-sb-org-text"><span class="r-sb-org-name">${esc(A.block.label)}</span><span class="r-sb-org-meta">${esc(A.block.meta)}</span></span></div>`
      : `<button class="r-sb-org r-me-org" data-part="org-switcher" aria-label="当前组织：${esc(M.org.name)}，切换组织"><span class="r-sb-org-initial">${esc(M.org.initial)}</span><span class="r-sb-org-text"><span class="r-sb-org-name">${esc(M.org.name)}</span><span class="r-sb-org-meta">~/${esc(M.org.slug)} · ${esc(orgRole)}</span></span>${icon("chevrons-up-down", 14)}</button>`;
    // The admin context: the console's pages in the manage group, the back row last, no
    // workspace group; the account group and the status line stay.
    const groups = inAdmin
      ? `<section class="r-me-group" data-part="group" aria-label="${esc(M.groups.manage)}"><h2 class="r-me-label" data-part="group-label">${esc(M.groups.manage)}</h2>${A.items.map((n) => meRow(n)).join("")}<a class="r-me-row" data-part="back-row" data-id="back" href="#">${icon(A.back.icon)}<span class="r-ellipsis">${esc(A.back.label)}</span></a></section>`
      : `${group("workspace")}${group("manage", admin)}`;
    const body = `<div class="r-me" data-part="me-panel" data-role="${role}"${inAdmin ? ' data-context="admin"' : ""}><div class="r-me-head"><div class="r-me-account" data-part="account"><span class="r-avatar">${esc(M.account.initial)}</span><span class="r-ellipsis">${esc(M.account.name)}</span></div>${org}</div>${groups}<section class="r-me-group" data-part="group" aria-label="${esc(M.accountGroup)}"><h2 class="r-me-label" data-part="group-label">${esc(M.accountGroup)}</h2>${M.accountItems.map((n) => meRow(n)).join("")}</section><p class="r-me-system" data-part="system-status">${esc(M.system)}</p></div>`;
    return `<div class="r-screen" data-part="screen" data-auto>${topBar({ title: M.title })}<div class="r-ld-scroll">${body}</div>${bottomNav({ current: "me", badge: true })}</div>`;
  }

  // ── Sheet drag states (§6.7, §7.4 of the layout spec) ────────────────────

  function sheet(o) {
    const drag = o.state === "settling" ? S.settling : S.dragging;
    const options = S.options
      .map(
        (op) =>
          `<div class="r-sh-option" role="radio" aria-checked="${op.checked === true}" data-part="option"><span class="r-sh-check">${op.checked ? icon("check", 14) : ""}</span><span class="r-ellipsis">${esc(op.label)}</span><span class="r-sh-count">${op.count}</span></div>`,
      )
      .join("");
    return `<div class="r-sh-stage" data-part="sheet-stage" style="--r-drag:${drag}"><div class="r-sh-page">${topBar({ title: F.LIST_PAGE_FIXTURE.title })}<div class="r-ld-scroll"><div class="r-sh-rows">${table({ narrow: true, rows: 3 })}</div></div></div><div class="r-sh-scrim" data-part="scrim"></div><div class="r-sh" role="dialog" aria-modal="true" aria-label="${esc(S.title)}" data-state="${o.state}" data-part="sheet"><div class="r-sh-handle-zone" data-part="handle-zone"><span class="r-sh-handle" data-part="sheet-handle" aria-label="${esc(S.handle)}"></span></div><div class="r-sh-head" data-part="sheet-head"><h2 class="r-sh-title">${esc(S.title)}</h2><button class="r-icon-btn r-tb-btn" aria-label="${esc(S.close)}">${icon("x")}</button></div><div class="r-sh-body" role="radiogroup">${options}</div></div></div>`;
  }

  return {
    "bottom-nav": bottomNav,
    "top-bar": topBar,
    "list-detail": listDetail,
    "me-panel": mePanel,
    sheet,
  };
};
