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
    superAdmin: ["all", "member", "admin", "superAdmin"],
  };

  // ── Sidebar (v3: work and admin contexts) ─────────────────────────────────

  function navItem(n, o, extra = "") {
    const current = n.id === o.active ? ' aria-current="page"' : "";
    const st = o.hover === n.id ? "hover" : o.focus === n.id ? "focus" : "";
    const count =
      n.count !== undefined
        ? `<span class="r-nav-count" aria-hidden="true">${n.count}</span>`
        : "";
    const label = n.count !== undefined ? `${n.label}，${n.count} 项待处理` : n.label;
    const size = extra.includes("r-nav-sub") ? 14 : 16;
    if (o.mode === "rail") {
      const badge = n.count !== undefined ? `<span class="r-rail-badge">${n.count}</span>` : "";
      return `<a class="r-nav-item r-rail-item${extra}" href="#" aria-label="${esc(label)}"${current}${state(st)}>${icon(n.icon)}${badge}</a>`;
    }
    return `<a class="r-nav-item${extra}" href="#" aria-label="${esc(label)}"${current}${state(st)}>${icon(n.icon, size)}<span class="r-ellipsis">${esc(n.label)}</span>${count}</a>`;
  }

  function convRow(c, o) {
    // `activeTitle` renames the current conversation (the B template blocks show their own title).
    const title = c.id === o.activeConversation && o.activeTitle ? o.activeTitle : c.title;
    const untitled = title === null;
    const text = untitled ? `${F.UNTITLED_CONVERSATION} · ${stamp(c.startedAt)}` : title;
    const isCurrent = c.id === o.activeConversation;
    const st = o.hover === c.id ? "hover" : o.focus === c.id ? "focus" : "";
    const dot =
      c.activity && !o.archived
        ? `<span class="r-conv-dot" data-activity="${c.activity}" aria-hidden="true"></span>`
        : "";
    const menu = isCurrent
      ? `<button class="r-row-menu" aria-label="会话操作">${icon("more-horizontal", 14)}</button>`
      : "";
    return `<div class="r-conv-row"${isCurrent ? ' data-current="true"' : ""}${state(st)}>${dot}<a class="r-conv" href="#" title="${esc(text)}"${isCurrent ? ' aria-current="page"' : ""}><span class="r-ellipsis">${esc(text)}</span></a>${menu}</div>`;
  }

  function group(g, o) {
    const collapsed = (o.collapsed || []).includes(g.agentId);
    const plus = o.archived
      ? ""
      : `<button class="r-icon-btn" data-step="dense" aria-label="${esc(F.SIDEBAR_COPY.newConversationIn.replace("{agent}", g.agentName))}">${icon("plus", 14)}</button>`;
    const head = `<div class="r-group-head"${state(o.hover === g.agentId ? "hover" : "")}>
      <button class="r-group-toggle" aria-expanded="${!collapsed}" title="${esc(g.agentName)}"><span class="r-ellipsis">${esc(g.agentName)}</span>${icon(collapsed ? "chevron-right" : "chevron-down", 12)}</button>${plus}
    </div>`;
    if (collapsed) return `<div class="r-group">${head}</div>`;
    const more = g.more ? `<button class="r-conv-more">${esc(F.SIDEBAR_COPY.more)}</button>` : "";
    return `<div class="r-group">${head}${g.conversations.map((c) => convRow(c, o)).join("")}${more}</div>`;
  }

  function conversationList(o) {
    if (o.state === "empty")
      return `<div class="r-sb-empty"><p class="r-sb-empty-text">${esc(F.SIDEBAR_COPY.empty)}</p><a class="r-btn" data-variant="default" data-step="dense" href="#">${esc(F.NEW_CONVERSATION_LABEL)}</a></div>`;
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
    let groups = o.archived
      ? F.GROUPS_FIXTURE.slice(1)
      : o.groups === "long"
        ? [F.LONG_TITLE_GROUP_FIXTURE, ...F.GROUPS_FIXTURE.slice(1)]
        : o.groups === "many"
          ? F.MANY_GROUPS_FIXTURE
          : F.GROUPS_FIXTURE;
    if (o.filter && (o.filter !== "all" || o.query)) {
      const q = (o.query ?? "").toLowerCase();
      groups = groups
        .map((g) => ({
          ...g,
          more: false,
          conversations: g.conversations.filter(
            (c) =>
              (o.filter === "all" || c.activity === o.filter) &&
              (c.title ?? "").toLowerCase().includes(q),
          ),
        }))
        .filter((g) => g.conversations.length > 0);
      // the in-list form of the compact empty state, centered as the DataTable's empty area
      if (groups.length === 0)
        return `<div class="r-sb-empty" data-state="no-match"><p class="r-sb-empty-text">${esc(F.SIDEBAR_COPY.noMatch)}</p><button class="r-btn" data-variant="default" data-step="dense">${esc(F.SIDEBAR_COPY.clearFilter)}</button></div>`;
    }
    const moreGroups =
      o.groups === "many" && F.MANY_GROUPS_MORE
        ? `<button class="r-conv-more">${esc(F.SIDEBAR_COPY.moreGroups)}</button>`
        : "";
    return groups.map((g) => group(g, o)).join("") + moreGroups;
  }

  function conversations(o) {
    const C = F.SIDEBAR_COPY;
    const n = F.ARCHIVED_COUNT_FIXTURE;
    // the archived list's icon button sits in the head before the filter (spec §6.13), shown
    // while the plain list is up
    const archive =
      !o.archived && !o.state
        ? `<button class="r-icon-btn" data-step="dense" aria-label="${esc(C.archived)} · ${n}" title="${esc(C.archived)} · ${n}">${icon("archive", 14)}</button>`
        : "";
    const head = `<div class="r-sb-convs-head"><span class="r-sb-section">${esc(C.conversations)}</span>${archive}<button class="r-icon-btn" data-step="dense" aria-label="${esc(C.filter)}"${o.filter ? ' data-active="true"' : ""}>${icon("filter", 14)}</button></div>`;
    const filter = o.filter
      ? `<div class="r-sb-filter"><input class="r-input r-sb-filter-input" placeholder="${esc(C.filterQuery)}" aria-label="${esc(C.filterQuery)}"${o.query ? ` value="${esc(o.query)}"` : ""}><div class="r-seg r-seg-fill r-sb-filter-seg" role="radiogroup" aria-label="会话状态">${C.states
          .map((label, i) => `<button role="radio" aria-checked="${["all", "running", "waiting"][i] === o.filter}">${esc(label)}</button>`)
          .join("")}</div></div>`
      : "";
    const back = o.archived
      ? `<button class="r-sb-archived" data-back="true">${icon("arrow-left", 14)}<span class="r-ellipsis">${esc(C.archived)} · ${n}</span></button>`
      : "";
    return `<div class="r-sb-convs" aria-label="${esc(C.conversations)}">${head}${filter}${back}${conversationList(o)}</div>`;
  }

  function orgBlock(o) {
    const org = F.ORG_SWITCHER_FIXTURE;
    if (o.mode === "rail") {
      return `<button class="r-sb-org" data-rail="true" aria-label="当前组织：${esc(org.name)}，切换组织"><span class="r-sb-org-initial">${esc(org.initial)}</span></button>`;
    }
    return `<button class="r-sb-org" aria-label="当前组织：${esc(org.name)}，切换组织"><span class="r-sb-org-initial">${esc(org.initial)}</span><span class="r-sb-org-text"><span class="r-sb-org-name">${esc(org.name)}</span><span class="r-sb-org-meta">~/${esc(org.slug)} · ${esc(org.role)}</span></span>${icon("chevrons-up-down", 14)}</button>`;
  }

  function adminBlock(o) {
    const C = F.SIDEBAR_COPY;
    const slug = F.ORG_SWITCHER_FIXTURE.slug;
    if (o.mode === "rail") {
      return `<div class="r-sb-context"><div class="r-sb-org" data-static="true" data-rail="true"><span class="r-sb-org-initial" data-tone="accent">${icon("admin", 14)}</span></div><a class="r-sb-back r-rail-item" href="#" aria-label="${esc(C.back)} ~/${esc(slug)}">${icon("arrow-left", 14)}</a></div>`;
    }
    return `<div class="r-sb-context"><div class="r-sb-org" data-static="true"><span class="r-sb-org-initial" data-tone="accent">${icon("admin", 14)}</span><span class="r-sb-org-text"><span class="r-sb-org-name">${esc(F.ADMIN_LABEL)}</span><span class="r-sb-org-meta">${esc(C.adminScope)}</span></span></div><a class="r-sb-back" href="#">${icon("arrow-left", 14)}<span class="r-ellipsis">${esc(C.back)} ~/${esc(slug)}</span></a></div>`;
  }

  // The setup context (web-SSR spec §4): the setup home, the steps with their state marks, the
  // 可以稍后再做 label before the optional ones (a divider in the rail).
  function setupNav(o) {
    const S = F.SETUP_COPY;
    const rail = o.mode === "rail";
    const MARK = { done: "check", todo: "circle", waiting: "clock" };
    const home = navItem({ id: "home", label: S.home, icon: "diamond" }, o);
    const step = (s) => {
      const st = o.hover === s.id ? "hover" : o.focus === s.id ? "focus" : "";
      const stateText = s.state === "waiting" ? s.reason || S.waiting : S[s.state];
      const name = `${s.label}，${stateText}`;
      const mark = `<span class="r-step-mark" data-state="${s.state}">${icon(MARK[s.state])}</span>`;
      const reason = !rail && s.state === "waiting" && s.reason;
      const text = rail
        ? ""
        : reason
          ? `<span class="r-step-text"><span class="r-ellipsis">${esc(s.label)}</span><span class="r-step-reason">${esc(s.reason)}</span></span>`
          : `<span class="r-ellipsis">${esc(s.label)}</span>`;
      const cls = `r-nav-item r-step${rail ? " r-rail-item" : ""}`;
      if (s.state === "waiting") {
        return `<span class="${cls}" role="link" aria-disabled="true" aria-label="${esc(name)}"${reason ? ' data-reason="true"' : ""}${state(st)}>${mark}${text}</span>`;
      }
      const current = s.id === o.active ? ' aria-current="page"' : "";
      const pending = o.pending === s.id ? '<span class="r-link-pending" aria-hidden="true"></span>' : "";
      return `<a class="${cls}" href="#" aria-label="${esc(name)}"${current}${state(st)}>${mark}${text}${pending}</a>`;
    };
    const steps = F.SETUP_STEPS_FIXTURE[o.setup || "admin"];
    const required = steps.filter((s) => !s.optional);
    const optional = steps.filter((s) => s.optional);
    const later =
      optional.length === 0
        ? ""
        : rail
          ? `<span class="r-step-divider" aria-hidden="true"></span>${optional.map(step).join("")}`
          : `<div class="r-step-group" role="group" aria-label="${esc(S.later)}"><span class="r-step-group-label">${esc(S.later)}</span>${optional.map(step).join("")}</div>`;
    return `${home}${required.map(step).join("")}${later}`;
  }

  function sidebar(o) {
    const level = o.level || "superAdmin";
    const rail = o.mode === "rail";
    const setup = o.context === "setup";
    const admin = o.context === "admin";
    const C = F.SIDEBAR_COPY;
    // Search and the inbox: brand-row icon buttons (rail icons under the expand button).
    const inboxItem = F.NAV_FIXTURE.find((n) => n.place === "brand");
    const inboxLabel = inboxItem
      ? inboxItem.count
        ? `${inboxItem.label}，${inboxItem.count} 项待处理`
        : inboxItem.label
      : "";
    const inboxBadge = inboxItem?.count ? `<span class="r-rail-badge">${inboxItem.count}</span>` : "";
    const tools = admin || setup
      ? ""
      : `<button class="r-icon-btn${rail ? " r-rail-item" : ""}" aria-label="${esc(C.search)} ${esc(C.searchShortcut)}">${icon("search")}</button>${
          inboxItem
            ? `<a class="r-icon-btn r-sb-inbox${rail ? " r-rail-item" : ""}" href="#" aria-label="${esc(inboxLabel)}"${o.active === "inbox" ? ' aria-current="page"' : ""}>${icon("inbox")}${inboxBadge}</a>`
            : ""
        }`;
    const top = rail
      ? `<div class="r-sb-top">${LOGO}</div>
         <div class="r-sb-rail-tools"><button class="r-icon-btn r-rail-item" aria-label="${esc(C.expand)}">${icon("panel-left")}</button>${tools}</div>`
      : `<div class="r-sb-top">${LOGO}<span class="r-wordmark">CAPYBARA</span><span class="r-sb-top-tools">${tools}${o.mode === "drawer" ? `<button class="r-icon-btn" aria-label="关闭导航">${icon("x")}</button>` : ""}</span></div>`;
    let nav;
    if (setup) {
      nav = setupNav(o);
    } else if (admin) {
      nav = F.ADMIN_NAV_FIXTURE.map((n) => navItem(n, o)).join("");
    } else {
      const visible = F.NAV_FIXTURE.filter((n) => VISIBLE[level].includes(n.audience));
      const primary = visible.filter((n) => n.place === "primary");
      const more = visible.filter((n) => n.place === "more");
      const ext = F.EXTENSION_PAGES_FIXTURE.map((p) => ({ id: p.id, label: p.label }));
      const activeInMore = [...more, ...ext].some((n) => n.id === o.active);
      const newConv = navItem({ id: "new", label: F.NEW_CONVERSATION_LABEL, icon: "plus" }, o);
      const active = activeInMore ? ' data-active="true"' : "";
      const moreToggle = rail
        ? `<button class="r-nav-item r-rail-item r-nav-more" aria-label="${esc(F.MORE_LABEL)}" aria-haspopup="menu"${active}>${icon("more-horizontal")}</button>`
        : `<button class="r-nav-item r-nav-more" aria-haspopup="menu" aria-expanded="${o.moreOpen === true}"${active}>${icon("more-horizontal")}<span class="r-ellipsis">${esc(F.MORE_LABEL)}</span>${icon("chevron-right", 12)}</button>`;
      // 更多 opens a flyout menu to the right of the sidebar, extension pages after a separator.
      const flyItem = (n) =>
        `<a class="r-menu-item" href="#"${n.id === o.active ? ' aria-current="page"' : ""}><span class="r-menu-label">${esc(n.label)}</span></a>`;
      const flyout = o.moreOpen
        ? `<div class="r-menu r-nav-flyout" role="menu" aria-label="${esc(F.MORE_LABEL)}">${more.map(flyItem).join("")}${more.length > 0 && ext.length > 0 ? '<div class="r-menu-sep"></div>' : ""}${ext.map(flyItem).join("")}</div>`
        : "";
      nav = `${newConv}${primary.map((n) => navItem(n, o)).join("")}<div class="r-nav-more-wrap">${moreToggle}${flyout}</div>`;
    }
    const navBlock = `<nav class="r-sb-nav" aria-label="主导航">${nav}</nav>`;
    const context = admin ? adminBlock(o) : orgBlock(o);
    const middle = admin || setup || rail ? '<div class="r-sb-fill"></div>' : conversations(o);
    const adminEntry =
      !admin && level === "superAdmin" && (!setup || (o.setup || "admin") === "admin")
        ? rail
          ? `<a class="r-nav-item r-rail-item r-sb-admin" href="#" aria-label="${esc(F.ADMIN_LABEL)}">${icon("admin")}</a>`
          : `<a class="r-nav-item r-sb-admin" href="#">${icon("admin")}<span class="r-ellipsis">${esc(F.ADMIN_LABEL)}</span>${icon("arrow-up-right", 14)}</a>`
        : "";
    const foot = rail
      ? `<div class="r-sb-foot"><span class="r-avatar" title="${esc(C.account)}">${F.FIXTURE_USER.initial}</span></div>`
      : `<div class="r-sb-foot"><span class="r-avatar">${F.FIXTURE_USER.initial}</span><span class="r-ellipsis">${esc(C.account)}</span><span class="r-theme">${icon("sun", 12)}${icon("moon", 12)}</span></div>`;
    return `<aside class="r-sidebar" data-mode="${o.mode || "full"}">${top}${context}${navBlock}${middle}${adminEntry}${foot}</aside>`;
  }

  // ── Page header, stat cards, status bar, action row ──────────────────────

  function pageHeader(o) {
    const L = F.LIST_PAGE_FIXTURE;
    const title = o.title || L.title;
    // Loading (spec §4.2): a title-size bar, two action blocks and two tab bars; nothing known yet.
    if (o.loading) {
      const loadSegs = F.FORM_PAGE_FIXTURE.path.slice(0, 1);
      const loadCrumb = `<nav class="r-ph-crumb" aria-label="路径">${loadSegs
        .map((c) => `<span class="r-ink">${esc(c.label)}</span>`)
        .join("")}</nav>`;
      // `o.loading` is true (two actions, two tabs) or { actions, tabs } counts.
      const nActions = typeof o.loading === "object" ? (o.loading.actions ?? 0) : 2;
      const nTabs = typeof o.loading === "object" ? (o.loading.tabs ?? 0) : 2;
      const loadBox = (i) =>
        `<div class="r-skel-box"${i === 0 ? ' data-part="skeleton-box"' : ""} data-box="default" style="width:72px"></div>`;
      const loadActions =
        nActions > 0
          ? `<div class="r-ph-actions">${Array.from({ length: nActions }, (_, i) => loadBox(i)).join("")}</div>`
          : "";
      // `tabItems`: the page's static tabs, drawn for real while the data loads (a detail page's
      // in-page tabs are the head's tab row, spec §4.2, §5.2).
      const tabItems = typeof o.loading === "object" ? o.loading.tabItems : undefined;
      const loadTabs = tabItems
        ? `<div class="r-ph-tabs"><div class="r-ph-tablist" role="tablist">${tabItems
            .map((t, i) => `<span role="tab" aria-selected="${i === 0}">${esc(t)}</span>`)
            .join("")}</div></div>`
        : nTabs > 0
          ? `<div class="r-ph-tabs r-ph-tabs-loading"><div class="r-ph-tab-slots" data-part="page-header-tab-slots">${Array.from({ length: nTabs }, () => '<div class="r-skel-text" data-size="body" style="width:56px"><span class="r-skel-bar"></span></div>').join("")}</div></div>`
          : "";
      return `<header class="r-ph"${o.narrow ? " data-narrow" : ""} aria-busy="true">${loadCrumb}<div class="r-ph-row"><div class="r-ph-text"><div class="r-skel-text" data-part="skeleton-text" data-size="title" style="width:30%"><span class="r-skel-bar" data-part="skeleton-bar"></span></div></div>${loadActions}</div>${loadTabs}</header>`;
    }
    const segs = o.path ? F.FORM_PAGE_FIXTURE.path : F.FORM_PAGE_FIXTURE.path.slice(0, 1);
    const crumb = `<nav class="r-ph-crumb" aria-label="路径">${segs
      .map((c, i) =>
        c.href && i < segs.length - 1
          ? `<a href="#">${esc(c.label)}</a>`
          : `<span${i === segs.length - 1 ? ' class="r-ink"' : ""}>${esc(c.label)}</span>`,
      )
      .join('<span aria-hidden="true">/</span>')}</nav>`;
    const desc = o.description ? `<p class="r-ph-desc">${esc(L.description)}</p>` : "";
    const secondary = o.narrow
      ? `<button class="r-icon-btn" data-variant="default" aria-label="更多操作">${icon("more-horizontal", 14)}</button>`
      : `<button class="r-btn" data-variant="default">${esc(L.secondaryAction)}</button>`;
    const actions = o.actions
      ? `<div class="r-ph-actions">${secondary}<button class="r-btn" data-variant="primary">${icon("plus", 14)}${esc(L.primaryAction)}</button></div>`
      : "";
    // Phones (spec §4.2): the search on its own line above the tabs, which scroll on theirs.
    const P = F.PAGE_HEADER_FIXTURE;
    const tabs = o.tabs
      ? `<div class="r-ph-tabs"><label class="r-search">${icon("search", 14)}<span class="r-sr">${esc(P.search)}</span><input placeholder="${esc(P.search)}"></label><div class="r-ph-tablist" role="tablist">${P.tabs
          .map(
            (t, i) =>
              `<span role="tab" aria-selected="${i === 0}">${esc(t.label)}${o.pending ? '<span class="r-ph-count" data-pending="true">–</span>' : `<span class="r-ph-count">${t.count}</span>`}</span>`,
          )
          .join("")}</div></div>`
      : "";
    return `<header class="r-ph"${o.narrow ? " data-narrow" : ""}>${crumb}<div class="r-ph-row"><div class="r-ph-text"><h1 class="r-ph-title" title="${esc(title)}">${esc(title)}</h1>${desc}</div>${actions}</div>${tabs}</header>`;
  }

  function stats(o) {
    const metrics = o.five ? F.LIST_PAGE_FIXTURE.metricsFive : F.LIST_PAGE_FIXTURE.metrics;
    return `<div class="r-stats"${o.narrow ? " data-narrow" : ""}>${metrics
      .map(
        (m, i) =>
          `<div class="r-stat"${o.linkState && i === 0 ? ` data-state="${o.linkState}"` : ""}><div class="r-stat-label">${esc(m.label)}</div><div class="r-stat-value"${m.tone ? ` data-tone="${m.tone}"` : ""}>${esc(m.value)}</div></div>`,
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
    // Loading (spec §5.3): the row stays, nothing to count, the buttons disabled.
    if (o.loading) {
      return `<div class="r-actionrow"><span class="r-actionrow-text"></span><button class="r-btn" data-variant="default" disabled>${esc(A.discard)}</button><button class="r-btn" data-variant="primary" disabled>${esc(A.save)}</button></div>`;
    }
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
    if (o.narrow) {
      // Phones (spec §6.6): stacked rows; the name is the card's title line, then label: value.
      const line = (label, value, cls = "") =>
        `<div class="r-stack-line"><span class="r-stack-label">${esc(label)}</span><span class="r-ellipsis${cls}">${value}</span></div>`;
      const cards = (o.rows ? L.rows.slice(0, o.rows) : L.rows).map(
        (r) =>
          `<div class="r-stack-row"><div class="r-stack-title"><div class="r-cell-name"><span class="r-initial" aria-hidden="true">${esc(r.name.slice(0, 1))}</span><div class="r-min0"><div class="r-ellipsis">${esc(r.name)}</div><div class="r-cell-desc r-ellipsis">${esc(r.description)}</div></div></div><button class="r-icon-btn" data-step="touch" aria-label="${esc(L.rowActions)}">${icon("more-horizontal", 14)}</button></div>${line(C.type, esc(r.type), " r-muted")}${line(C.status, statusCell(r.status))}${line(C.tools, esc(String(r.tools)))}${line(C.calls7d, esc(r.calls7d), " r-muted")}${line(C.owner, esc(r.owner), " r-muted")}</div>`,
      );
      return `<div class="r-table r-stacked">${cards.join("")}</div>`;
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

  /** A loading field (spec §5.3): the field head holds a 30% body slot, then a control-height box. */
  function loadingField() {
    return '<div class="r-field" data-part="loading-field"><div class="r-field-head"><div class="r-skel-text" data-part="skeleton-text" data-size="body" style="width:30%"><span class="r-skel-bar" data-part="skeleton-bar"></span></div></div><div class="r-skel-box" data-part="skeleton-box" data-box="default"></div></div>';
  }

  /** A loading switch row (spec §5.3): name and description slots, a 32 x 20 box. */
  function loadingSwitchRow() {
    return '<div class="r-switch-row" data-part="loading-switch-row"><div class="r-min0"><div class="r-skel-text" data-part="skeleton-text" data-size="body" style="width:30%"><span class="r-skel-bar" data-part="skeleton-bar"></span></div><div class="r-skel-text" data-part="skeleton-text" data-size="small" style="width:55%"><span class="r-skel-bar" data-part="skeleton-bar"></span></div></div><div class="r-skel-box" data-part="skeleton-box" style="width:32px;height:20px"></div></div>';
  }

  function formSections(o = {}) {
    return F.FORM_PAGE_FIXTURE.sections
      .map((s) => {
        if (o.loading) {
          const sw = s.fields[0]?.kind === "switches" ? s.fields[0] : null;
          const body = sw
            ? `<div class="r-switch-list">${sw.rows.map(loadingSwitchRow).join("")}</div>`
            : s.fields.map(loadingField).join("");
          return `<section class="r-form-section"><div class="r-form-intro"><h2 class="r-h2">${esc(s.title)}</h2><p class="r-prose-small r-muted">${esc(s.description)}</p></div><div class="r-form-card${sw ? " r-form-card-flush" : ""}">${body}</div></section>`;
        }
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
    return `<div class="r-app">${sidebar({ active: "connectors", activeConversation: null })}<main class="r-main"><div class="r-main-scroll"><div class="r-content" data-width="content">${pageHeader({ description: true, actions: true })}${stats({})}${toolbar()}${table({})}${pagination()}</div></div>${statusBar({})}</main></div>`;
  }

  function formPage(o = {}) {
    const P = F.FORM_PAGE_FIXTURE;
    const head = o.loading
      ? pageHeader({ loading: { actions: 0, tabs: 0 } })
      : pageHeader({ path: true, title: P.title });
    return `<div class="r-app">${sidebar({ active: "agents", activeConversation: null })}<main class="r-main"><div class="r-main-scroll"><div class="r-content" data-width="content">${head}${formSections(o)}</div></div>${actionRow(o)}${statusBar({ context: P.status.context, pageStatus: P.status.pageStatus })}</main></div>`;
  }

  // ── List and trace loading states (spec §5.1, §5.11) ──────────────────────

  const skelText = (w, size = "body") =>
    `<div class="r-skel-text" data-part="skeleton-text" data-size="${size}" style="width:${w}"><span class="r-skel-bar" data-part="skeleton-bar"></span></div>`;

  /** The objects list while loading: the real header with dashes for the counts, three object rows. */
  function listLoadingObjects() {
    const row = `<li class="r-lrow" data-part="loading-row"><div class="r-skel-box" data-part="skeleton-box" data-box="mark"></div><div class="r-lrow-text">${skelText("30%")}${skelText("55%")}</div></li>`;
    const head = pageHeader({ title: F.PAGE_HEADER_FIXTURE.title, actions: true, tabs: true, pending: true });
    return `<div class="r-tpl" aria-busy="true"><div class="r-tpl-head">${head}</div><div class="r-tpl-body"><div class="r-tpl-main"><ul class="r-llist" data-part="loading-list">${row.repeat(3)}</ul></div></div></div>`;
  }

  /** The trace page while loading: stat slots, 11 waterfall rows (the loaded fixture's spans), a card. */
  function traceLoading() {
    const stat = `<div class="r-stat r-lstat" data-part="stat-card"><div class="r-stat-label">${skelText("55%", "small")}</div><div class="r-stat-value">${skelText("45%", "metric")}</div></div>`;
    const row = (i) =>
      `<div class="r-wf-row" data-part="loading-span-row"><div class="r-wf-name">${skelText(i % 2 === 0 ? "70%" : "55%")}</div><div class="r-wf-track"></div><div class="r-wf-status"></div><div class="r-wf-ms">${skelText("100%")}</div></div>`;
    const card = `<section class="r-lcard" data-part="loading-card"><header class="r-lcard-head">${skelText("30%")}</header><div class="r-lcard-body">${skelText("100%")}${skelText("70%")}${skelText("55%")}</div></section>`;
    const head = pageHeader({ loading: { actions: 1, tabs: 0 } });
    return `<div class="r-tpl" aria-busy="true"><div class="r-tpl-head" data-stats>${head}<div class="r-stats">${stat.repeat(4)}</div></div><div class="r-tpl-body"><div class="r-trace"><div class="r-trace-wf"><div class="r-wf">${Array.from({ length: 11 }, (_, i) => row(i)).join("")}</div></div><div class="r-trace-detail">${card}</div></div></div></div>`;
  }

  function drawer(o) {
    return `<div class="r-drawer-stage"><div class="r-drawer-page"><div class="r-drawer-bar"><button class="r-icon-btn" aria-label="${esc(F.SIDEBAR_COPY.menu)}" aria-expanded="true">${icon("menu")}</button><span class="r-ellipsis">${esc(F.LIST_PAGE_FIXTURE.title)}</span><button class="r-icon-btn r-drawer-bar-end" aria-label="${esc(F.SIDEBAR_COPY.search)} ${esc(F.SIDEBAR_COPY.searchShortcut)}">${icon("search")}</button></div><div class="r-drawer-body">${pageHeader({ description: true })}${stats({})}</div>${statusBar({ noPageStatus: true })}</div><div class="r-scrim"></div><div class="r-drawer" role="dialog" aria-modal="true" aria-label="导航">${sidebar({ ...o, mode: "drawer" })}</div></div>`;
  }

  // Below 960 in the setup frame: the setup home behind the scrim, the setup drawer over it; the
  // drawer bar has no search (no command palette in the setup frame).
  function setupDrawer(o) {
    const S = F.SETUP_COPY;
    const head = `<header class="r-ph"><nav class="r-ph-crumb" aria-label="路径"><span>${esc(F.ORG_SWITCHER_FIXTURE.slug)}</span><span aria-hidden="true">/</span><span class="r-ink">${esc(S.home)}</span></nav><div class="r-ph-row"><div class="r-ph-text"><h1 class="r-ph-title">${esc(S.home)}</h1></div></div></header>`;
    return `<div class="r-drawer-stage"><div class="r-drawer-page"><div class="r-drawer-bar"><button class="r-icon-btn" aria-label="${esc(F.SIDEBAR_COPY.menu)}" aria-expanded="true">${icon("menu")}</button><span class="r-ellipsis">${esc(S.home)}</span></div><div class="r-drawer-body">${head}</div>${statusBar({ noPageStatus: true })}</div><div class="r-scrim"></div><div class="r-drawer" role="dialog" aria-modal="true" aria-label="导航">${sidebar({ ...o, context: "setup", mode: "drawer" })}</div></div>`;
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

  // ── Select (§6.2): a field-like button opening the anchored listbox (§6.16.3) ──

  function selectField(o) {
    const S = F.SELECT_FIXTURE;
    const L = F.LONG_MODELS_FIXTURE;
    const long = o.state === "long";
    const open = long || o.state === "open";
    const options = long
      ? L.groups.flatMap((g) => g.models.map((m) => ({ value: m.id, label: m.label })))
      : S.options;
    const value = long ? L.selected : o.state === "placeholder" ? "" : S.value;
    const chosen = options.find((x) => x.value === value);
    const shown = chosen
      ? `<span class="r-ellipsis" data-part="select-label">${esc(chosen.label)}</span>`
      : `<span class="r-ellipsis r-faint" data-part="select-label" data-placeholder="true">${esc(S.placeholder)}</span>`;
    const st = o.state === "error" ? ' data-state="error"' : open ? ' data-state="focus"' : "";
    const field = `<button class="r-input r-select-field" data-part="select" role="combobox" aria-haspopup="listbox" aria-expanded="${open}"${st}${o.state === "disabled" ? " disabled" : ""}><span class="r-select-value" data-part="input-control">${shown}</span>${icon("chevron-down", 14)}</button>`;
    const error = o.state === "error" ? `<span class="r-field-error">${icon("circle-alert", 12)}${esc(S.error)}</span>` : "";
    let list = "";
    if (open) {
      // the long list is scrolled to the selected option: the rows in view end on it
      const at = options.findIndex((x) => x.value === value);
      const view = long ? options.slice(Math.max(0, at - 8), at + 1) : options;
      const rows = view
        .map((x) => {
          const sel = x.value === value;
          return `<div class="r-menu-item" data-part="menu-item" role="option" aria-selected="${sel}"><span class="r-ellipsis">${esc(x.label)}</span><span class="r-grow"></span>${sel ? icon("check", 14) : ""}</div>`;
        })
        .join("");
      const filter = long ? '<input class="r-menu-filter" data-part="menu-filter" placeholder="筛选" aria-label="筛选">' : "";
      list = `<div class="r-menu r-select-list${long ? " r-menu-capped" : ""}" data-part="menu" role="listbox">${filter}<div class="r-menu-list">${rows}</div></div>`;
    }
    return `<div class="r-field"><label class="r-label">${esc(long ? S.longLabel : S.label)}</label><div class="r-select-stage">${field}${list}</div>${error}</div>`;
  }

  const RENDER = {
    sidebar,
    rail,
    setupDrawer,
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
    "list-loading-objects": listLoadingObjects,
    "trace-loading": traceLoading,
    "form-page": formPage,
    "icon-grid": iconGrid,
    select: selectField,
  };

  // The conversation-page renderers (conversation.js, UI refresh B) when the page loads them.
  if (window.__CB_EXTRA__) {
    Object.assign(RENDER, window.__CB_EXTRA__({ F, esc, icon, state, stamp, sidebar, statusBar }));
  }

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
