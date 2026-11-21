// Mobile-layout renderers of the reference set (design spec §6.47, §6.7 sheet drag states).
// Loaded before fill.js, which merges them into its RENDER table: window.__CB_EXTRA__(helpers)
// returns { kind: (opts) => html }. Not product code: it draws the target design from
// TOP_BAR_FIXTURE, LIST_DETAIL_FIXTURE and SHEET_FIXTURE
// (@capybara-hq/design/fixtures). Every size is a token step (reference.css, "Mobile layout").
window.__CB_EXTRA__ = ({ F, esc, icon, table }) => {
  const T = F.TOP_BAR_FIXTURE;
  const L = F.LIST_DETAIL_FIXTURE;
  const S = F.SHEET_FIXTURE;

  // ── TopBar (the sheet stage's page head) ──────────────────────────────

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

  function decisionButton(d) {
    return `<button class="r-btn" data-variant="${d.variant}">${esc(d.label)}</button>`;
  }

  // Compact (§4.4): the secondary decisions side by side on one line, the primary alone on the
  // full-width line under them. Two panes keep the ordinary ActionRow (primary rightmost).
  function decisionRow(o = {}) {
    const ds = L.detail.decisions;
    if (!o.compact) {
      return `<div class="r-actionrow r-ld-actions" data-part="action-row"><span class="r-actionrow-text"></span>${ds
        .map((d) => decisionButton(d))
        .join("")}</div>`;
    }
    const primary = ds.filter((d) => d.variant === "primary");
    const others = ds.filter((d) => d.variant !== "primary");
    // The ActionRow's own parts (spec §4.4): the secondaries' line and the primary's line.
    const line = (list, part) =>
      list.length
        ? `<div class="r-actionrow-line" data-part="${part}">${list.map((d) => decisionButton(d)).join("")}</div>`
        : "";
    return `<div class="r-actionrow r-ld-actions" data-part="action-row" data-compact>${line(others, "action-secondary")}${line(primary, "action-primary")}</div>`;
  }

  // The floating row's back (§6.56): a round control.prominent button over the page's top.
  function floatBack() {
    return `<div class="r-float-row" data-part="floating-bar"><a class="r-float-btn" data-part="float-btn" href="#" aria-label="返回">${icon("chevron-left")}</a></div>`;
  }

  function listDetail(o) {
    if (o.mode === "compact-list") {
      // The chat-first shell (§4.6): the inbox is a pushed page, the floating row leads with back.
      return `<div class="r-screen" data-part="screen">${floatBack()}<div class="r-ld-scroll">${listRows({})}</div></div>`;
    }
    if (o.mode === "compact-detail") {
      // The detail is a pushed page: the floating back returns to the list and the decision row
      // is sticky at the bottom.
      return `<div class="r-screen" data-part="screen">${floatBack()}<div class="r-ld-scroll">${detailBody()}</div>${decisionRow({ compact: true })}</div>`;
    }
    // two-pane: the list column (320) beside the detail (at least 360)
    return `<div class="r-ld-panes" data-part="list-detail" data-mode="two-pane"><div class="r-ld-listcol" data-part="list-pane">${listRows({ current: "ib1" })}</div><div class="r-ld-detailcol" data-part="detail-pane"><div class="r-ld-scroll">${detailBody()}</div>${decisionRow()}</div></div>`;
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
    return `<div class="r-sh-stage" data-part="sheet-stage" style="--r-drag:${drag}"><div class="r-sh-page">${topBar({ title: F.LIST_PAGE_FIXTURE.title })}<div class="r-ld-scroll"><div class="r-sh-rows">${table({ narrow: true, rows: 3 })}</div></div></div><div class="r-sh-scrim" data-part="scrim"></div><div class="r-sh" role="dialog" aria-modal="true" aria-label="${esc(S.title)}" data-drag="${o.state}" data-part="sheet"><div class="r-sh-handle-zone" data-part="handle-zone"><span class="r-sh-handle" data-part="sheet-handle" aria-label="${esc(S.handle)}"></span></div><div class="r-sh-head" data-part="sheet-head"><h2 class="r-sh-title">${esc(S.title)}</h2><button class="r-icon-btn r-tb-btn" aria-label="${esc(S.close)}">${icon("x")}</button></div><div class="r-sh-body" role="radiogroup">${options}</div></div></div>`;
  }

  // bottom-nav, top-bar and me-panel left the design with the chat-first shell (mobile touch plan
  // Task 28); their renderers stay only where list-detail and sheet still draw them
  return {
    "list-detail": listDetail,
    sheet,
  };
};
