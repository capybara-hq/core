// ScheduleCalendar renderers of the reference set (spec §6.40). Loaded before fill.js, which merges
// them into its RENDER table: window.__CB_EXTRA__(helpers) returns { kind: (opts) => html }.
// Not product code: it draws the target design from SCHEDULE_CALENDAR_FIXTURE
// (@capybara-hq/design/fixtures). Every size is a token step (reference.css, "ScheduleCalendar").
window.__CB_EXTRA__ = ({ F, esc, icon }) => {
  const S = F.SCHEDULE_CALENDAR_FIXTURE;
  const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const NARROW = ["一", "二", "三", "四", "五", "六", "日"];
  const STATE_ICON = {
    upcoming: "clock",
    running: "spinner",
    completed: "check",
    failed: "circle-x",
    skipped: "ban",
  };
  const SLOT = 30;

  const parse = (day) => {
    const [y, m, d] = day.split("-").map(Number);
    return { m, d, wd: (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 };
  };
  const dayLabel = (day) => {
    const p = parse(day);
    return `${p.m}月${p.d}日 ${WEEKDAYS[p.wd]}`;
  };
  const top = (minute) => `calc(var(--cb-layout-calendar-hour) * ${minute / 60})`;
  const nowMinute = () => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: S.timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(S.now);
    const v = (t) => Number(parts.find((p) => p.type === t).value);
    return v("hour") * 60 + v("minute");
  };

  // Overlapping half hours share the column, three at most; with more, two and 「+N」 third.
  function placeDay(items) {
    const sorted = [...items].sort((a, b) => a.minute - b.minute || a.id.localeCompare(b.id));
    const out = [];
    let cluster = [];
    let end = -1;
    const flush = () => {
      if (!cluster.length) return;
      const laneEnd = [];
      const lane = new Map();
      for (const it of cluster) {
        let l = laneEnd.findIndex((e) => e <= it.minute);
        if (l < 0) {
          l = laneEnd.length;
          laneEnd.push(0);
        }
        laneEnd[l] = it.minute + SLOT;
        lane.set(it.id, l);
      }
      const lanes = laneEnd.length;
      if (lanes <= 3) {
        for (const it of cluster) out.push({ kind: "item", item: it, lane: lane.get(it.id), lanes });
      } else {
        const rest = [];
        for (const it of cluster) {
          if (lane.get(it.id) < 2) out.push({ kind: "item", item: it, lane: lane.get(it.id), lanes: 3 });
          else rest.push(it);
        }
        out.push({ kind: "more", items: rest, minute: rest[0].minute, lane: 2, lanes: 3 });
      }
      cluster = [];
      end = -1;
    };
    for (const it of sorted) {
      if (cluster.length && it.minute >= end) flush();
      cluster.push(it);
      end = Math.max(end, it.minute + SLOT);
    }
    flush();
    return out;
  }

  const stateIcon = (state) =>
    `<span class="r-scal-icon" data-part="schedule-calendar-icon" data-state="${state}">${icon(STATE_ICON[state], 12)}</span>`;
  const itemLine = (it) =>
    `${stateIcon(it.state)}<span class="r-scal-time" data-part="schedule-calendar-time">${esc(it.time)}</span><span class="r-scal-title" data-part="schedule-calendar-title">${esc(it.title)}</span>${it.mark ? `<span class="r-scal-mark">${esc(it.mark)}</span>` : ""}`;
  const chipLine = (c) =>
    `${stateIcon(c.state)}<span class="r-scal-title" data-part="schedule-calendar-title">${esc(c.title)}</span><span class="r-scal-summary" data-part="schedule-calendar-summary">${esc(c.summary)}</span>${c.failed ? `<span class="r-scal-chip-failed" data-part="schedule-calendar-chip-failed">· ${esc(c.failed)}</span>` : ""}`;
  const sel = (id, o) => (id === o.selectedId ? ' data-selected="true" aria-current="true"' : "");

  function toolbar(o) {
    const month = o.range === "month";
    const agenda = o.range === "agenda";
    const seg = (name, opts, value) =>
      `<div class="r-seg" role="radiogroup" aria-label="${name}">${opts
        .map(([v, l]) => `<button aria-checked="${v === value}">${esc(l)}</button>`)
        .join("")}</div>`;
    const end = agenda
      ? `<button class="r-icon-btn" data-variant="ghost" aria-label="视图选项">${icon("sliders")}</button>`
      : seg("视图", [["week", "周"], ["month", "月"]], month ? "month" : "week") +
        (o.scope ? seg("范围", [["mine", S.scope.mine], ["all", S.scope.all]], o.scope) : "");
    return `<div class="r-scal-toolbar" data-part="schedule-calendar-toolbar"><button class="r-btn" data-variant="default">今天</button><button class="r-icon-btn" data-variant="ghost" aria-label="${month ? "上个月" : "上一周"}">${icon("chevron-left")}</button><button class="r-icon-btn" data-variant="ghost" aria-label="${month ? "下个月" : "下一周"}">${icon("chevron-right")}</button><span class="r-scal-range" data-part="schedule-calendar-range">${esc(o.rangeLabel)}</span><span class="r-scal-tools-end">${end}</span></div>`;
  }

  function errorLine(o) {
    if (!o.error) return "";
    return `<div class="r-scal-error" data-part="schedule-calendar-error"><span class="r-scal-error-text" data-part="schedule-calendar-error-text">${icon("circle-x", 14)}加载失败</span><span class="r-scal-error-code">${esc(S.errorCode)}</span><button class="r-btn" data-variant="default" data-step="dense">重试</button></div>`;
  }

  function emptyOver(o, inline) {
    if (!o.empty) return "";
    const E = S.empty;
    return `<div class="r-scal-empty" data-part="schedule-calendar-empty"${inline ? ' data-inline="true"' : ""}><div class="r-scal-empty-panel"><div class="r-sb-empty" data-part="empty-state" data-size="panel"><span class="r-empty-art" data-part="empty-illustration" aria-hidden="true">${LOGO_LINE}</span><span class="r-empty-words"><p class="r-empty-text" data-part="empty-state-text">${esc(E.text)}</p><p class="r-empty-hint" data-part="empty-state-hint">${esc(E.hint)}</p></span><span class="r-empty-action"><button class="r-btn" data-variant="default" data-step="dense">${esc(E.action)}</button></span></div></div></div>`;
  }

  function week(o) {
    const items = o.loading || o.empty ? [] : S.week.items;
    const collapsed = o.dense ? S.week.collapsed : [];
    const days = S.week.days;
    const heads = days
      .map((day) => {
        const p = parse(day);
        const today = day === S.today ? ' data-today="true"' : "";
        return `<div class="r-scal-dayhead" data-part="schedule-calendar-day-head"${today}><span class="r-scal-weekday">${WEEKDAYS[p.wd]}</span><span class="r-scal-date" data-part="schedule-calendar-date"${today}>${day.slice(5)}</span></div>`;
      })
      .join("");
    const lane = collapsed.length
      ? `<div class="r-scal-band r-scal-lane" data-part="schedule-calendar-lane"><span class="r-scal-corner"></span>${days
          .map(
            (day) =>
              `<div class="r-scal-lane-day">${collapsed
                .filter((c) => c.day === day)
                .map(
                  (c) =>
                    `<button class="r-scal-chip" data-part="schedule-calendar-chip" data-state="${c.state}" aria-label="${esc(c.label)}">${chipLine(c)}</button>`,
                )
                .join("")}</div>`,
          )
          .join("")}</div>`
      : "";
    const hours = Array.from(
      { length: 24 },
      (_, h) =>
        `<span class="r-scal-hour" data-part="schedule-calendar-hour">${String(h).padStart(2, "0")}:00</span>`,
    ).join("");
    const skeleton = [[540, 840], [540], [540, 840], [600], [540, 1020], [], [600]];
    const placed = days.map((day) => placeDay(items.filter((it) => it.day === day)));
    const earliest = Math.min(...placed.flat().map((p) => (p.kind === "item" ? p.item.minute : p.minute)), 480);
    const scrollTo = Math.max(0, Math.min(420, Math.floor(earliest / 60) * 60 - 60));
    const cols = days
      .map((day, i) => {
        const blocks = placed[i]
          .map((p) => {
            const m = p.kind === "item" ? p.item.minute : p.minute;
            const pos = `top:${top(m)};left:${(p.lane * 100) / p.lanes}%;width:calc(${100 / p.lanes}% - 2px)`;
            if (p.kind === "more")
              return `<button class="r-scal-more" data-part="schedule-calendar-more" style="${pos}" aria-label="另外 ${p.items.length} 项，${dayLabel(day)}">+${p.items.length}</button>`;
            return `<button class="r-scal-block" data-part="schedule-calendar-block" data-state="${p.item.state}"${sel(p.item.id, o)} style="${pos}" aria-label="${esc(p.item.label)}">${itemLine(p.item)}</button>`;
          })
          .join("");
        const skel = o.loading
          ? skeleton[i]
              .map((m) => `<span class="r-scal-skeleton" style="top:${top(m)}"><span class="r-skel r-scal-skel-box" data-part="skeleton-box"></span></span>`)
              .join("")
          : "";
        const now =
          day === S.today
            ? `<span class="r-scal-now" data-part="schedule-calendar-now" style="top:${top(nowMinute())}"></span>`
            : "";
        const today = day === S.today ? ' data-today="true"' : "";
        return `<div class="r-scal-day" data-part="schedule-calendar-day"${today} role="group" aria-label="${dayLabel(day)}">${skel}${blocks}${now}</div>`;
      })
      .join("");
    return `<div class="r-scal-grid" data-part="schedule-calendar-grid"><div class="r-scal-scroll" data-part="schedule-calendar-scroll" data-scroll="${(scrollTo / 60) * 40}"><div class="r-scal-pin"><div class="r-scal-band"><span class="r-scal-corner"></span>${heads}</div>${lane}</div><div class="r-scal-band r-scal-body" data-part="schedule-calendar-body"><div class="r-scal-axis" data-part="schedule-calendar-axis">${hours}</div>${cols}</div></div>${emptyOver(o)}</div>`;
  }

  function month(o) {
    const M = S.month;
    const shown = M.days[Math.floor(M.days.length / 2)].slice(0, 7);
    const head = WEEKDAYS.map(
      (w) => `<span class="r-scal-weekday" data-part="schedule-calendar-weekday">${w}</span>`,
    ).join("");
    const cells = M.days
      .map((day) => {
        const p = parse(day);
        const label = dayLabel(day);
        const lines = [
          ...M.collapsed.filter((c) => c.day === day).map((c) => ({ chip: c })),
          ...M.items
            .filter((it) => it.day === day)
            .sort((a, b) => a.minute - b.minute)
            .map((it) => ({ item: it })),
        ];
        const over = lines.length > 3;
        const visible = over ? lines.slice(0, 2) : lines;
        const body = visible
          .map((l) => {
            const x = l.chip || l.item;
            return `<button class="r-scal-line" data-part="schedule-calendar-line" data-state="${x.state}" aria-label="${esc(x.label)}">${l.chip ? chipLine(l.chip) : itemLine(l.item)}</button>`;
          })
          .join("");
        const more = over
          ? `<button class="r-scal-line r-scal-more-line" data-part="schedule-calendar-more" aria-label="另外 ${lines.length - 2} 项，${label}">+${lines.length - 2} 项</button>`
          : "";
        const today = day === S.today ? ' data-today="true"' : "";
        const outside = day.slice(0, 7) === shown ? "" : ' data-outside="true"';
        return `<div class="r-scal-cell" data-part="schedule-calendar-cell"${outside}${today} role="group" aria-label="${label}"><div class="r-scal-cell-head"><button class="r-scal-daynum" data-part="schedule-calendar-day-number" aria-label="${label}，查看这一周"><span class="r-scal-number" data-part="schedule-calendar-number"${today}>${p.d}</span></button></div>${body}${more}</div>`;
      })
      .join("");
    return `<div class="r-scal-grid" data-part="schedule-calendar-grid"><div class="r-scal-month-head">${head}</div><div class="r-scal-month" data-part="schedule-calendar-month">${cells}</div></div>`;
  }

  function agenda() {
    const W = S.week;
    const chosen = S.agendaDay;
    const failedOn = (day) =>
      W.items.some((it) => it.day === day && it.state === "failed") ||
      W.collapsed.some((c) => c.day === day && (c.state === "failed" || c.failed));
    const days = W.days
      .map((day) => {
        const p = parse(day);
        const today = day === S.today ? ' data-today="true" aria-current="date"' : "";
        const dot = failedOn(day)
          ? '<span class="r-scal-dot" data-part="schedule-calendar-dot"></span>'
          : "";
        return `<button class="r-scal-agenda-day" data-part="schedule-calendar-agenda-day"${today} aria-pressed="${day === chosen}"><span class="r-scal-agenda-wd">${NARROW[p.wd]}</span><span class="r-scal-agenda-num">${p.d}</span>${dot}</button>`;
      })
      .join("");
    const chips = W.collapsed
      .filter((c) => c.day === chosen)
      .map(
        (c) =>
          `<button class="r-scal-row" data-part="schedule-calendar-row" data-state="${c.state}" aria-label="${esc(c.label)}">${chipLine(c)}</button>`,
      )
      .join("");
    const rows = W.items
      .filter((it) => it.day === chosen)
      .sort((a, b) => a.minute - b.minute)
      .map(
        (it) =>
          `<button class="r-scal-row" data-part="schedule-calendar-row" data-state="${it.state}" aria-label="${esc(it.label)}">${itemLine(it)}<span class="r-scal-meta" data-part="schedule-calendar-meta">${esc(it.meta)}</span></button>`,
      )
      .join("");
    return `<div class="r-scal-agenda" data-part="schedule-calendar-agenda"><div class="r-scal-agenda-days">${days}</div><div class="r-scal-agenda-list" data-part="schedule-calendar-agenda-list">${chips}${rows}</div></div>`;
  }

  function calendar(o) {
    const range = o.range || "week";
    const rangeLabel = range === "month" ? S.month.rangeLabel : S.week.rangeLabel;
    const body = range === "agenda" ? agenda() : range === "month" ? month(o) : week(o);
    return `<div class="r-scal" data-part="schedule-calendar" data-range="${range}">${toolbar({ ...o, range, rangeLabel })}<div class="r-scal-box" data-part="schedule-calendar-box">${errorLine(o)}${body}</div><p class="r-scal-footnote" data-part="schedule-calendar-footnote">${esc(S.footnote)}</p></div>`;
  }

  // The week grid opens at 07:00 (or an hour before the earliest item): scroll once fill.js has
  // replaced the templates, before the page is captured.
  queueMicrotask(() => {
    for (const el of document.querySelectorAll(".r-scal-scroll[data-scroll]")) {
      el.scrollTop = Number(el.dataset.scroll);
    }
  });

  return { "schedule-calendar": calendar };
};

// The EmptyState's line-art capybara at scale 4 (57 × 41), as fill.js's sidebar draws it.
const LOGO_LINE =
  '<svg class="r-logo-line" width="57" height="41" viewBox="0 0 57 41" shape-rendering="crispEdges" aria-hidden="true"><path d="M40.5 0.5H44.5M40.5 0.5V4.5M44.5 0.5V4.5M36.5 4.5H40.5M36.5 4.5V8.5M44.5 4.5H48.5M48.5 4.5V8.5M12.5 8.5H16.5M12.5 8.5V12.5M16.5 8.5H20.5M20.5 8.5H24.5M24.5 8.5H28.5M28.5 8.5H32.5M32.5 8.5H36.5M44.5 12.5H48.5M48.5 8.5H52.5M52.5 8.5H56.5M56.5 8.5V12.5M8.5 12.5H12.5M8.5 12.5V16.5M44.5 12.5V16.5M48.5 12.5V16.5M56.5 12.5V16.5M4.5 16.5H8.5M4.5 16.5V20.5M44.5 16.5H48.5M56.5 16.5V20.5M4.5 20.5V24.5M52.5 24.5H56.5M56.5 20.5V24.5M4.5 28.5H8.5M4.5 24.5V28.5M48.5 28.5H52.5M52.5 24.5V28.5M8.5 28.5V32.5M16.5 32.5H20.5M20.5 32.5H24.5M28.5 32.5H32.5M32.5 32.5H36.5M44.5 32.5H48.5M48.5 28.5V32.5M8.5 32.5V36.5M16.5 32.5V36.5M24.5 32.5V36.5M28.5 32.5V36.5M36.5 32.5V36.5M44.5 32.5V36.5M8.5 40.5H12.5M8.5 36.5V40.5M12.5 40.5H16.5M16.5 36.5V40.5M24.5 40.5H28.5M24.5 36.5V40.5M28.5 36.5V40.5M36.5 40.5H40.5M36.5 36.5V40.5M40.5 40.5H44.5M44.5 36.5V40.5"/></svg>';
