// Conversation-page renderers of the reference set (UI refresh B). Loaded before fill.js, which
// merges them into its RENDER table: window.__CB_EXTRA__(helpers) returns { kind: (opts) => html }.
// Not product code: it draws the target design from @capybara-hq/design/fixtures (conversation.ts).
//
// Copy is zh placeholder copy; every size is a token step (reference.css, "Conversation" part).
window.__CB_EXTRA__ = ({ F, esc, icon, state, stamp, sidebar }) => {
  const C = F.CONV_FIXTURE;
  const K = F.CONV_COPY;
  const T = F.TOOL_FIXTURES;
  const H = F.HITL_FIXTURE;
  const D = F.DIVIDER_FIXTURE;
  const S = F.SUBAGENT_FIXTURE;
  const FI = F.FILE_FIXTURE;
  const P = F.PANEL_FIXTURE;

  const spin = (size = 12) => `<span class="r-spin" role="img" aria-label="进行中">${icon("spinner", size)}</span>`;
  const chev = (open) => icon(open ? "chevron-down" : "chevron-right", 12);
  const failWord = '<span class="r-fail-word">失败</span>';
  const iconBtn = (name, label, o = {}) =>
    `<button class="r-icon-btn"${o.step ? ` data-step="${o.step}"` : ""}${o.pressed ? ' aria-pressed="true"' : ""}${state(o.state)} aria-label="${esc(label)}">${icon(name, o.size || 16)}</button>`;
  const btn = (label, variant = "default", o = {}) =>
    `<button class="r-btn" data-variant="${variant}"${o.step ? ` data-step="${o.step}"` : ""}${state(o.state)}>${o.icon ? icon(o.icon, 14) : ""}${esc(label)}</button>`;

  /** "长文件名.xlsx" -> "前段…后段.xlsx": middle truncation that keeps the extension. */
  function midTrunc(name, max = 30) {
    const chars = [...name];
    if (chars.length <= max) return name;
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot) : "";
    const base = [...(dot > 0 ? name.slice(0, dot) : name)];
    const keep = max - [...ext].length - 1;
    const head = Math.ceil(keep * 0.6);
    const tail = keep - head;
    return `${base.slice(0, head).join("")}…${base.slice(base.length - tail).join("")}${ext}`;
  }
  const typeBadge = (t) => `<span class="r-ftype">${esc(t)}</span>`;
  const modelLabel = (provider, id) =>
    C.models.find((g) => g.provider === provider)?.models.find((m) => m.id === id)?.label ?? id;

  // ── Markdown (the subset the fixtures use; text is escaped, links only http(s)) ──

  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code class="r-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a class="r-link" href="$2">$1</a>');
  }
  function markdown(src) {
    const lines = src.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === "") {
        i++;
        continue;
      }
      const h = /^(#{1,3}) (.*)$/.exec(line);
      if (h) {
        out.push(`<h${h[1].length + 1} class="r-md-h">${inline(h[2])}</h${h[1].length + 1}>`);
        i++;
        continue;
      }
      if (line.startsWith("|")) {
        const rows = [];
        while (i < lines.length && lines[i].startsWith("|")) rows.push(lines[i++]);
        const cells = (r) => r.slice(1, -1).split("|").map((c) => c.trim());
        const align = cells(rows[1]).map((c) => (c.endsWith(":") ? ' class="r-num"' : ""));
        const head = cells(rows[0]).map((c, j) => `<th${align[j]}>${inline(c)}</th>`).join("");
        const body = rows
          .slice(2)
          .map((r) => `<tr>${cells(r).map((c, j) => `<td${align[j]}>${inline(c)}</td>`).join("")}</tr>`)
          .join("");
        out.push(`<table class="r-md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
        continue;
      }
      const list = /^(- |\d+\. )/.exec(line);
      if (list) {
        const ordered = list[1] !== "- ";
        const items = [];
        while (i < lines.length && /^(- |\d+\. )/.test(lines[i])) {
          items.push(`<li>${inline(lines[i].replace(/^(- |\d+\. )/, ""))}</li>`);
          i++;
        }
        out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^(#|\||- |\d+\. )/.test(lines[i])) {
        para.push(lines[i++]);
      }
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
    return out.join("");
  }

  // ── Tool rows and groups ───────────────────────────────────────────────

  /** "verb source: title key · extra" with the key arguments in body color. */
  function toolLabel(t) {
    let lead;
    if (t.kind === "command" && t.title) lead = t.title;
    else lead = [t.verb, t.source ? `${t.source}: ${t.title}` : t.title].filter(Boolean).join(" ");
    const key = t.keyArg ? ` <span class="r-em">${esc(t.keyArg)}</span>` : "";
    const extra =
      t.kind === "edit" && t.added !== undefined
        ? ` <span class="r-faint">· +${t.added} −${t.removed}</span>`
        : t.extra
          ? ` <span class="r-faint">· ${esc(t.extra)}</span>`
          : "";
    const fail = t.status === "failed" ? ` ${failWord}<span class="r-muted"> · ${esc(t.error)}</span>` : "";
    return `<span class="r-tlabel">${esc(lead)}${key}${extra}${fail}</span>`;
  }

  function toolDetail(t, o = {}) {
    const parts = [];
    if (t.input) {
      parts.push(
        `<div class="r-kv">${t.input.map(([k, v]) => `<span class="r-kv-k">${esc(k)}</span><span class="r-kv-v">${esc(v)}</span>`).join("")}</div>`,
      );
    }
    if (t.command) parts.push(`<div class="r-tcmd"><span class="r-faint">$</span> ${esc(t.command)}</div>`);
    if (t.output) parts.push(`<pre class="r-tout">${esc(t.output)}</pre>`);
    const foot = [];
    if (t.outputBytes) {
      foot.push(`<span>输出 ${Math.round(t.outputBytes / 1024)} KB，已显示前 4 KB</span>`);
      foot.push(`<button class="r-linkbtn">${esc(K.viewAll)}</button>`);
    } else if (t.durationMs !== undefined) {
      foot.push(`<span>${(t.durationMs / 1000).toFixed(1)} 秒</span>`);
      if (t.output) foot.push(`<button class="r-linkbtn">${esc(K.copyOutput)}</button>`);
    }
    if (foot.length) parts.push(`<div class="r-tfoot">${foot.join("")}</div>`);
    return `<div class="r-tdetail"${o.flush ? " data-flush" : ""}>${parts.join("")}</div>`;
  }

  function toolRow(t, o = {}) {
    const expandable = Boolean(t.input || t.output || t.command || t.diff);
    const lead = t.status === "running" ? spin() : "";
    const end =
      t.status === "running"
        ? `<span class="r-tend r-faint">${esc(t.elapsed)}</span>`
        : expandable
          ? `<span class="r-tend">${chev(o.open)}</span>`
          : "";
    const st = o.hover ? "hover" : o.focus ? "focus" : "";
    const row = `<div class="r-trow"${t.status === "running" ? ' data-running' : ""}${state(st)}${expandable ? ` role="button" aria-expanded="${Boolean(o.open)}"` : ""}>${lead}${toolLabel(t)}${end}</div>`;
    return o.open ? row + toolDetail(t) : row;
  }

  const KIND_GROUP = { command: "command", connector: "tool", tool: "tool", search: "tool", meta: "tool", read: "read", edit: "edit" };

  /** The group header: counts by kind with their verbs; one object is named. */
  function groupSummary(rows) {
    const running = rows.find((r) => r.status === "running");
    if (running) {
      const what = { command: "正在运行命令", tool: "正在使用工具", read: "正在读取文件", edit: "正在修改文件" }[KIND_GROUP[running.kind]];
      const done = rows.filter((r) => r.status !== "running").length;
      return `${spin()}<span class="r-tlabel">${what}<span class="r-faint"> · 已完成 ${done} 个</span></span>`;
    }
    const by = { command: [], tool: [], read: [], edit: [] };
    for (const r of rows) by[KIND_GROUP[r.kind]].push(r);
    const parts = [];
    if (by.command.length) parts.push(`已运行 ${by.command.length} 个命令`);
    if (by.tool.length) parts.push(`已使用 ${by.tool.length} 个工具`);
    if (by.read.length === 1) parts.push(`已读取 <span class="r-em">${esc(by.read[0].keyArg)}</span>`);
    else if (by.read.length) parts.push(`已读取 ${by.read.length} 个文件`);
    if (by.edit.length === 1) parts.push(`已修改 <span class="r-em">${esc(by.edit[0].keyArg)}</span>`);
    else if (by.edit.length) parts.push(`已修改 ${by.edit.length} 个文件`);
    const failed = rows.filter((r) => r.status === "failed").length;
    const fail = failed ? `<span class="r-fail-word">（${failed} 个失败）</span>` : "";
    const added = by.edit.reduce((n, r) => n + (r.added || 0), 0);
    const removed = by.edit.reduce((n, r) => n + (r.removed || 0), 0);
    const diff = by.edit.length ? `<span class="r-faint"> · +${added} −${removed}</span>` : "";
    return `<span class="r-tlabel">${parts.join("，")}${fail}${diff}</span>`;
  }

  function toolGroup(rows, o = {}) {
    if (rows.length === 1 && !o.forceGroup) {
      // A single call: one gray line, no box.
      return `<div class="r-tline" role="button" aria-expanded="${Boolean(o.open)}">${toolLabel(rows[0])}${chev(o.open)}</div>${o.open ? `<div class="r-tbox">${rows[0].diff ? diffBlock(rows[0]) : toolDetail(rows[0])}</div>` : ""}`;
    }
    const running = rows.some((r) => r.status === "running");
    const open = running || o.open;
    const head = `<div class="r-tline"${running ? "" : ` role="button" aria-expanded="${Boolean(open)}"`}>${groupSummary(rows)}${running ? "" : chev(open)}</div>`;
    if (!open) return head;
    const body = rows.map((r) => toolRow(r, { open: (o.openRows || []).includes(r.id) })).join("");
    return `${head}<div class="r-tbox">${body}</div>`;
  }

  function diffBlock(t, o = {}) {
    const lines = t.diff.map((l) => {
      const n = l.kind === "del" ? l.old : l.new;
      const sign = l.kind === "add" ? "+" : l.kind === "del" ? "−" : " ";
      return `<div class="r-dl"${l.kind === "ctx" ? "" : ` data-kind="${l.kind}"`}><span class="r-ln">${n ?? ""}</span><span class="r-sign">${sign}</span><span class="r-dtext">${esc(l.text)}</span></div>`;
    });
    // The shown count is computed from the drawn lines, as the product does (§7.1 amendment).
    const cut = o.truncated
      ? `<div class="r-dcut">差异过长，已截断 · 显示前 ${t.diff.length.toLocaleString("en-US")} / 10,000 行 · <button class="r-linkbtn">${esc(K.viewAll)}</button></div>`
      : "";
    return `<div class="r-diff">${lines.join("")}${cut}</div>`;
  }

  // ── Prose, thinking, bubbles, dividers ─────────────────────────────────

  const prose = (html) => `<div class="r-prose">${html}</div>`;

  function proseBlock(o) {
    if (o.state === "streaming")
      return prose(`<p>${esc(F.PROSE_FIXTURE.streaming)}<span class="r-cursor" aria-hidden="true"></span></p>`);
    if (o.state === "file-chip") {
      const known = new Set([...FI.outputs, ...FI.many].map((f) => f.name));
      let html = inline(F.PROSE_FIXTURE.withPaths);
      for (const p of FI.paths) {
        if (!known.has(p.split("/").pop())) continue;
        html = html.replace(esc(p), `<a class="r-pathchip" href="#">${esc(p)}</a>`);
      }
      return prose(`<p>${html}</p>`);
    }
    return prose(markdown(F.PROSE_FIXTURE.markdown));
  }

  function thinking(o) {
    const PR = F.PROSE_FIXTURE;
    if (o.state === "live")
      return `<div class="r-tline">${spin()}<span class="r-tlabel">正在思考<span class="r-faint"> · 4 秒</span></span></div><div class="r-think">${esc(PR.thinking.slice(0, 22))}<span class="r-cursor" aria-hidden="true"></span></div>`;
    const open = o.state === "expanded";
    const head = `<div class="r-tline" role="button" aria-expanded="${open}"><span class="r-tlabel">思考了 ${PR.thinkingSeconds} 秒</span>${chev(open)}</div>`;
    return open ? `${head}<div class="r-think">${esc(PR.thinking)}</div>` : head;
  }

  function attachmentChip(a) {
    if (a.kind === "image") return `<span class="r-thumb" role="img" aria-label="${esc(a.name)}"></span>`;
    return `<span class="r-achip">${typeBadge(a.type)}<span class="r-ellipsis">${esc(midTrunc(a.name, 22))}</span><span class="r-muted">${esc(a.size)}</span></span>`;
  }

  function userBubble(o) {
    const withAtts = o.state === "attachments";
    const atts = withAtts
      ? `<div class="r-uatts"><div class="r-row-tight">${attachmentChip(FI.attachments[0])}${attachmentChip(FI.attachments[0])}</div>${attachmentChip(FI.attachments[1])}</div>`
      : "";
    const text = withAtts ? "帮我对一下这几个文件" : C.user.text;
    return `<div class="r-ucol">${atts}<div class="r-bubble">${esc(text)}</div></div>`;
  }

  function divider(o) {
    const rule = '<span class="r-drule"></span>';
    const line = (body, tone) => `<div class="r-divider"${tone ? ` data-tone="${tone}"` : ""} role="status">${rule}<span>${body}</span>${rule}</div>`;
    switch (o.state) {
      case "stopped":
        return line(`已停止 · ${esc(D.stopped.who)} ${esc(D.stopped.at)}`);
      case "failed":
        return line(`运行失败：${esc(D.failed.reason)} · <button class="r-linkbtn" data-tone="fail">${esc(K.retry)}</button>`, "fail");
      case "compacted":
        return line(`较早的对话已压缩 · 节省 ${esc(D.compacted.saved)} · <button class="r-linkbtn" aria-expanded="false">查看摘要</button>`);
      case "compacted-open":
        return `${line(`较早的对话已压缩 · 节省 ${esc(D.compacted.saved)} · <button class="r-linkbtn" aria-expanded="true">收起摘要</button>`)}<div class="r-summary">${esc(D.compacted.summary)}</div>`;
      case "fallback":
        return line(`所选模型 ${esc(D.fallback.from)} 已不可用，本条起改用 agent 的模型 ${esc(D.fallback.to)}`);
      case "hook-denied":
        return line(`运行被扩展「${esc(D.hookDenied.extension)}」拦截：${esc(D.hookDenied.reason)}`, "fail");
    }
    return "";
  }

  // ── Human in the loop ──────────────────────────────────────────────────

  const kv = (pairs, cls = "") =>
    `<div class="r-kv${cls}">${pairs.map(([k, v]) => `<span class="r-kv-k">${esc(k)}</span><span class="r-kv-v">${esc(v)}</span>`).join("")}</div>`;
  // The model-visible tool key after the title: the title is unreviewed text, the key is not.
  const toolKey = (k) => `<span class="r-faint r-small r-tkey">${esc(k)}</span>`;

  function approval(o) {
    const A = H.approval;
    const W = H.decided;
    if (o.state === "approved")
      return `<div class="r-tline">${icon("check", 12)}<span class="r-tlabel">${esc(W.who)} 批准了 ${esc(W.approved.tool)} <span class="r-faint">${esc(W.approved.toolKey)} · ${esc(W.approved.scope)} · ${esc(W.approved.at)}</span></span></div>`;
    if (o.state === "denied")
      return `<div class="r-tline">${icon("x", 12)}<span class="r-tlabel">${esc(W.who)} 拒绝了 ${esc(W.denied.tool)} <span class="r-faint">${esc(W.denied.toolKey)}</span><span class="r-muted"> · 「${esc(W.denied.reason)}」</span><span class="r-faint"> · ${esc(W.denied.at)}</span></span></div>`;
    const scopes = o.state === "pending-once" ? ["once"] : A.scopes;
    const head = `<div class="r-card-head"><span class="r-dot" aria-hidden="true"></span><strong>需要你批准</strong><span class="r-muted r-small">${esc(A.tool)}</span>${toolKey(A.toolKey)}</div>`;
    const args = `<div class="r-args">${kv(A.args, " r-kv-capped")}<button class="r-linkbtn r-small">查看完整输入</button></div>`;
    let actions;
    if (o.state === "deny-reason") {
      actions = `<div class="r-deny"><label class="r-sr" for="deny">拒绝原因</label><input class="r-input" id="deny" data-state="focus" value="${esc(A.denyReason)}" placeholder="拒绝原因（选填，会告诉模型）"><div class="r-card-actions">${btn("拒绝", "danger")}${btn("取消", "ghost")}<span class="r-card-note">原因会写入会话，模型能看到</span></div></div>`;
    } else {
      const LABEL = { once: "批准", session: "本会话内都批准", always: "总是批准" };
      const buttons = scopes.map((s, i) => btn(LABEL[s], i === 0 ? "primary" : "default")).join("");
      actions = `<div class="r-card-actions">${buttons}${btn("拒绝…", "default")}<span class="r-card-note">${esc(A.policy)}</span></div>`;
    }
    return `<div class="r-card" data-pending role="group" aria-label="需要你批准">${head}${args}${actions}</div>`;
  }

  function question(o) {
    const Q = H.question;
    if (o.state === "answered")
      return `<div class="r-qa"><div class="r-tline"><span class="r-tlabel">${esc(Q.question)}</span></div><div class="r-tline">${icon("corner-down-right", 12)}<span class="r-tlabel"><span class="r-em">${esc(H.decided.answered.answer)}</span><span class="r-faint"> · ${esc(H.decided.who)}</span></span></div></div>`;
    if (o.state === "skipped")
      return `<div class="r-qa"><div class="r-tline"><span class="r-tlabel">${esc(Q.question)}</span></div><div class="r-tline">${icon("corner-down-right", 12)}<span class="r-tlabel">已跳过<span class="r-faint"> · ${esc(H.decided.who)}</span></span></div></div>`;
    if (o.state === "url") {
      const U = H.questionUrl;
      return `<div class="r-card" role="group" aria-label="${esc(U.question)}"><div class="r-card-title">${esc(U.question)}</div><a class="r-url" href="#">${icon("external-link", 14)}<span>${esc(U.url)}</span></a><div class="r-card-actions">${btn("打开链接", "primary", { icon: "external-link" })}${btn("跳过", "default")}<span class="r-card-note">完成后回到这里继续</span></div></div>`;
    }
    const opts = Q.options
      .map(
        (x, i) =>
          `<label class="r-opt"${i === Q.selected ? " data-checked" : ""}><span class="r-radio" aria-hidden="true"></span>${esc(x)}</label>`,
      )
      .join("");
    const other = `<label class="r-opt"><span class="r-radio" aria-hidden="true"></span>其他：<input class="r-opt-input" placeholder="${esc(Q.other)}"></label>`;
    return `<div class="r-card" role="group" aria-label="${esc(Q.question)}"><div class="r-card-title">${esc(Q.question)}</div><div class="r-opts" role="radiogroup">${opts}${other}</div><div class="r-card-actions">${btn("回答", "primary")}${btn("跳过", "default")}</div></div>`;
  }

  function connect(o) {
    const X = H.connect;
    if (o.state === "closed")
      return `<div class="r-tline">${icon("connector", 12)}<span class="r-tlabel">${esc(H.decided.who)} 已连接 ${esc(H.decided.connected.service)}<span class="r-faint"> · ${esc(H.decided.connected.at)}</span></span></div>`;
    return `<div class="r-card r-card-row" role="group" aria-label="${esc(X.reason)}"><span class="r-initial r-initial-lg" aria-hidden="true">A</span><div class="r-min0"><div>${esc(X.reason)}</div><div class="r-muted r-small">${esc(X.note)}</div></div>${btn("连接", "primary")}</div>`;
  }

  function queued(o) {
    const items = F.QUEUE_FIXTURE;
    const sent = `<div class="r-bubble">${esc(C.user.second)}</div>`;
    const actions = (i) =>
      `<div class="r-qactions"><span class="r-faint">排队中</span>${iconBtn("copy", "复制", { step: "dense", size: 14 })}${iconBtn("square-pen", "编辑", { step: "dense", size: 14 })}${iconBtn("trash-2", "删除", { step: "dense", size: 14 })}${btn("立即发送", "default", { step: "dense", state: o.state === "hover" && i === 0 ? "hover" : "" })}</div>`;
    const q = items
      .map((m, i) => {
        if (o.state === "editing" && i === 0)
          return `<div class="r-qedit"><label class="r-sr" for="qedit">编辑排队消息</label><textarea class="r-input r-textarea r-prose-input" id="qedit" rows="2" data-state="focus">${esc(m.text)}</textarea><div class="r-qactions">${btn("取消", "ghost", { step: "dense" })}${btn("保存", "primary", { step: "dense" })}</div></div>`;
        const bubble = `<div class="r-bubble" data-queued>${esc(m.text)}</div>`;
        return o.state === "paused" ? bubble : bubble + actions(i);
      })
      .join("");
    const paused =
      o.state === "paused"
        ? `<div class="r-qactions"><span class="r-muted">运行已停止，队列已暂停（${items.length} 条）</span>${btn("继续发送", "default", { step: "dense" })}</div>`
        : "";
    return `<div class="r-ucol">${sent}${q}${paused}</div>`;
  }

  // ── Composer and picker menus ──────────────────────────────────────────

  function picker(label, o = {}) {
    if (o.locked)
      return `<span class="r-picker" data-locked title="${esc(K.agentLocked)}">${esc(label)}</span>`;
    return `<button class="r-btn r-picker" data-variant="ghost"${o.open ? ' aria-expanded="true" data-state="hover"' : ""}>${esc(label)}${icon("chevron-down", 12)}</button>`;
  }

  function composer(o = {}) {
    const isNew = o.state === "new";
    const running = o.state === "running";
    const model = o.state === "no-effort" ? C.noEffortModel : C.selected;
    const effort =
      o.state === "no-effort" ? "" : picker(C.effortLabels[C.selected.effort], { open: o.menu === "effort" });
    const strip = o.state === "attachments" ? `<div class="r-astrip">${FI.attachments.slice(0, 2).map(attachmentChip).join("")}</div>` : "";
    const placeholder = isNew ? K.newPlaceholder.replace("研究助手", C.agent.name) : running ? K.queueHint : K.placeholder;
    const value = o.state === "attachments" ? "帮我对一下这几个文件" : o.state === "focus" ? "再按收款人汇总一张表" : "";
    const action = running
      ? `<button class="r-icon-btn r-stop" aria-label="${esc(K.stop)}">${icon("square", 14)}</button>`
      : `<button class="r-icon-btn r-send" aria-label="${esc(K.send)}"${value ? "" : " disabled"}>${icon("arrow-up", 16)}</button>`;
    return `<div class="r-composer"${o.state === "focus" ? ' data-state="focus"' : ""}>${strip}<label class="r-sr" for="msg">消息</label><textarea class="r-composer-input" id="msg" rows="1" placeholder="${esc(placeholder)}">${esc(value)}</textarea><div class="r-composer-bar">${iconBtn("plus", K.attach)}${picker(C.agent.name, { locked: !isNew, open: o.menu === "agent" })}${picker(modelLabel(model.provider, model.model), { open: o.menu === "model" })}${effort}<span class="r-grow"></span>${action}</div></div>`;
  }

  function pickerMenu(o) {
    let body;
    if (o.menu === "model") {
      body = C.models
        .map((g, gi) => {
          const items = g.models
            .map((m) => {
              const sel = g.provider === C.selected.provider && m.id === C.selected.model;
              const tag = gi === 0 && m === g.models[0] ? '<span class="r-tag">agent 默认</span>' : "";
              return `<div class="r-menu-item" role="menuitemradio" aria-checked="${sel}">${esc(m.label)}${tag}<span class="r-grow"></span>${sel ? icon("check", 14) : ""}</div>`;
            })
            .join("");
          return `<div class="r-menu-label">${esc(g.label)}</div>${items}`;
        })
        .join("");
      body += `<div class="r-menu-note">${esc(K.modelHint)}</div>`;
    } else if (o.menu === "effort") {
      const efforts = C.models[0].models[0].efforts;
      body = efforts
        .map((e) => {
          const sel = e === C.selected.effort;
          return `<div class="r-menu-item" role="menuitemradio" aria-checked="${sel}">${esc(C.effortLabels[e])}<span class="r-grow"></span>${sel ? icon("check", 14) : ""}</div>`;
        })
        .join("");
      body += `<div class="r-menu-note">${esc(K.modelHint)}</div>`;
    } else {
      body = C.agents
        .map((a) => {
          const sel = a.id === C.agent.id;
          return `<div class="r-menu-item" role="menuitemradio" aria-checked="${sel}">${esc(a.name)}<span class="r-grow"></span>${sel ? icon("check", 14) : ""}</div>`;
        })
        .join("");
      body += `<div class="r-menu-note">${esc(K.agentLocked)}</div>`;
    }
    const left = { agent: "var(--cb-space-7)", model: "calc(var(--cb-space-8) * 3)", effort: "calc(var(--cb-space-8) * 5)" }[o.menu];
    return `<div class="r-menu-stage"><div class="r-menu" role="menu" style="left:${left}">${body}</div>${composer({ state: o.menu === "agent" ? "new" : "idle", menu: o.menu })}</div>`;
  }

  // ── Title bar ──────────────────────────────────────────────────────────

  function titleBar(o = {}) {
    const untitled = o.state === "untitled";
    const title = untitled
      ? `${F.UNTITLED_CONVERSATION} · ${stamp(C.untitledAt)}`
      : o.state === "long-title"
        ? C.longTitle
        : o.title || C.title;
    const menuOpen = o.state === "rename-menu";
    const pressed = o.state === "panel-active" ? "files" : o.pressed;
    const ext = o.state === "overflow" ? [] : [["list-checks", "待办"], ["extension", "任务看板"]];
    const group2 = [["file-text", K.files, "files"], ...ext.map(([i, l]) => [i, l, l])]
      .map(([i, l, id]) => iconBtn(i, l, { pressed: pressed === id }))
      .join("");
    const menu = menuOpen
      ? `<div class="r-menu r-title-menu" role="menu"><div class="r-menu-item" role="menuitem">${icon("square-pen", 14)}${esc(K.rename)}</div><div class="r-menu-item" role="menuitem">${icon("link", 14)}${esc(K.copyLink)}</div><div class="r-menu-sep"></div><div class="r-menu-item" role="menuitem" data-tone="fail">${icon("trash-2", 14)}${esc(K.delete)}</div></div>`
      : "";
    const more = o.state === "overflow"
      ? `<div class="r-menu r-more-menu" role="menu"><div class="r-menu-item" role="menuitem">${icon("list-checks", 14)}待办</div><div class="r-menu-item" role="menuitem">${icon("extension", 14)}任务看板</div></div>`
      : "";
    return `<header class="r-titlebar"><button class="r-title"${untitled ? " data-untitled" : ""} aria-haspopup="menu" aria-expanded="${menuOpen}"${menuOpen ? ' data-state="hover"' : ""} title="${esc(title)}"><span class="r-ellipsis">${esc(title)}</span>${icon("chevron-down", 14)}</button>${iconBtn("panel-right", K.properties, { pressed: pressed === "properties" })}<span class="r-vsep" aria-hidden="true"></span>${group2}${iconBtn("more-vertical", K.more, { pressed: o.state === "overflow" })}${menu}${more}</header>`;
  }

  // ── Sub-agents ─────────────────────────────────────────────────────────

  function subRow(s, o = {}) {
    const lead = s.status === "running" ? spin() : "";
    const status = s.status === "failed" ? `${failWord}<span class="r-faint"> · </span>` : "";
    const meta = `<span class="r-tend r-faint">${status}${s.toolCalls} 次调用 · ${esc(s.duration)}</span>`;
    const open = o.open ? ' aria-current="true"' : "";
    const row = `<div class="r-trow r-subrow"${open}${o.expanded !== undefined ? ` aria-expanded="${o.expanded}"` : ""} role="button">${lead}<span class="r-tag">${esc(s.agentType)}</span><span class="r-tlabel"><span class="r-em">${esc(s.description)}</span></span>${meta}${o.expanded !== undefined ? chev(o.expanded) : icon("chevron-right", 12)}</div>`;
    if (!o.expanded) return row;
    const steps = (s.steps || []).map((x) => `<div>${esc(x)}</div>`).join("");
    return `${row}<div class="r-substeps">${steps}<p class="r-subresult">${esc(s.result)}</p><button class="r-linkbtn">${icon("maximize-2", 12)}在右侧打开完整记录</button></div>`;
  }

  function subGroup(o) {
    if (o.state === "done") {
      const failed = S.done.filter((s) => s.status === "failed").length;
      return `<div class="r-tline" role="button" aria-expanded="false"><span class="r-tlabel">${S.done.length} 个子 agent 已完成<span class="r-fail-word">（${failed} 个失败）</span><span class="r-faint"> · 共 ${S.totals.calls} 次调用 · ${esc(S.totals.duration)}</span></span>${chev(false)}</div>`;
    }
    if (o.state === "failed" || o.state === "expanded") {
      const failed = S.done.filter((s) => s.status === "failed").length;
      const head = `<div class="r-tline" role="button" aria-expanded="true"><span class="r-tlabel">${S.done.length} 个子 agent 已完成<span class="r-fail-word">（${failed} 个失败）</span><span class="r-faint"> · 共 ${S.totals.calls} 次调用 · ${esc(S.totals.duration)}</span></span>${chev(true)}</div>`;
      const rows = S.done.map((s, i) => subRow(s, { expanded: o.state === "expanded" && i === 0 ? true : o.state === "expanded" ? false : undefined })).join("");
      return `${head}<div class="r-tbox">${rows}</div>`;
    }
    const head = `<div class="r-tline">${spin()}<span class="r-tlabel">正在运行 ${S.running.length} 个子 agent</span></div>`;
    const rows = S.running.map((s) => subRow(s, { open: o.state === "row-open" && s.id === S.open })).join("");
    return `${head}<div class="r-tbox">${rows}</div>`;
  }

  // ── Files ──────────────────────────────────────────────────────────────

  function fileCard(f, o = {}) {
    if (f.removed)
      return `<div class="r-fcard" data-removed>${typeBadge(f.type)}<span class="r-fname r-ellipsis">${esc(f.name)}</span><span>${esc(f.reason)}</span></div>`;
    const st = o.hover ? "hover" : o.focus ? "focus" : "";
    return `<a class="r-fcard" href="#"${state(st)} title="${esc(f.name)}">${typeBadge(f.type)}<span class="r-fname">${esc(midTrunc(f.name, o.max || 30))}</span><span class="r-muted">${esc(f.size)}</span>${icon("chevron-right", 12)}</a>`;
  }

  function fileCardBlock(o) {
    if (o.state === "removed") return fileCard(FI.removed);
    if (o.state === "long-name") return fileCard(FI.outputs[1]);
    return fileCard(FI.outputs[0], { hover: o.state === "hover", focus: o.state === "focus" });
  }

  function chart() {
    const bars = [40, 55, 35, 70, 90, 60, 45, 80]
      .map((h, i) => `<span class="r-bar"${i === 4 ? " data-hi" : ""} style="height:${h}%"></span>`)
      .join("");
    return `<div class="r-chart" aria-hidden="true">${bars}</div>`;
  }

  function fileOutputs(o) {
    if (o.state === "two") return `<div class="r-fgrid">${FI.outputs.map((f) => fileCard(f, { max: 24 })).join("")}</div>`;
    if (o.state === "more") {
      const shown = FI.many.slice(0, 3).map((f) => fileCard(f, { max: 24 })).join("");
      return `<div class="r-fgrid">${shown}<a class="r-fcard r-fmore" href="#">还有 ${FI.many.length - 3} 个文件${icon("chevron-right", 12)}</a></div>`;
    }
    if (o.state === "image" || o.state === "image-hover") {
      const I = FI.image;
      const tools =
        o.state === "image-hover"
          ? `<div class="r-imgtools">${iconBtn("zoom-in", "放大", { step: "dense", size: 14 })}${iconBtn("download", K.download, { step: "dense", size: 14 })}</div>`
          : "";
      return `<figure class="r-img"><div class="r-img-frame"${o.state === "image-hover" ? ' data-state="hover"' : ""}>${chart()}${tools}</div><figcaption class="r-tline"><span class="r-tlabel"><span class="r-em">${esc(I.name)}</span><span class="r-faint"> · ${esc(I.dimensions)} · ${esc(I.size)}</span></span></figcaption></figure>`;
    }
    const X = FI.text;
    return `<div class="r-ftext"><div class="r-ftext-head">${typeBadge(X.type)}<span class="r-fname r-ellipsis">${esc(X.name)}</span><span class="r-muted">${esc(X.size)}</span><button class="r-linkbtn">${esc(K.open)}${icon("chevron-right", 12)}</button></div><pre class="r-ftext-body">${esc(X.head)}</pre></div>`;
  }

  function attachmentStrip(o) {
    const A = FI.attachments;
    const pick = { image: A[0], file: A[1], uploading: A[2], rejected: A[3] }[o.state];
    let item;
    if (o.state === "image")
      item = `<span class="r-thumb-wrap">${attachmentChip(pick)}<button class="r-thumb-x" aria-label="移除 ${esc(pick.name)}">${icon("x", 12)}</button></span>`;
    else if (o.state === "uploading")
      item = `<span class="r-achip" data-uploading><span class="r-achip-row">${typeBadge(pick.type)}<span class="r-ellipsis">${esc(pick.name)}</span><span class="r-muted">${pick.progress}%</span></span><span class="r-progress" role="progressbar" aria-valuenow="${pick.progress}"><span style="width:${pick.progress}%"></span></span></span>`;
    else if (o.state === "rejected")
      item = `<span class="r-achip" data-rejected>${typeBadge(pick.type)}<span class="r-ellipsis">${esc(pick.name)}</span><span class="r-fail-text">${esc(pick.error)}</span></span>`;
    else
      item = `<span class="r-achip">${typeBadge(pick.type)}<span class="r-ellipsis">${esc(pick.name)}</span><span class="r-muted">${esc(pick.size)}</span><button class="r-icon-btn" data-step="dense" aria-label="移除 ${esc(pick.name)}">${icon("x", 12)}</button></span>`;
    return `<div class="r-astrip">${item}</div>`;
  }

  // ── Right panel and previews ───────────────────────────────────────────

  function panelHeader(o) {
    const back = o.back ? iconBtn("chevron-left", K.back) : "";
    const badge = o.type ? typeBadge(o.type) : "";
    const meta = o.meta ? `<span class="r-faint r-small r-nowrap">${o.meta}</span>` : "";
    const title = o.switcher === false
      ? `<span class="r-panel-title r-ellipsis">${esc(o.title)}</span>`
      : `<button class="r-panel-title r-btn" data-variant="ghost"${o.switching ? ' aria-expanded="true" data-state="hover"' : ""}><span class="r-ellipsis">${esc(o.title)}</span>${icon("chevron-down", 14)}</button>`;
    const actions = (o.actions || []).join("");
    return `<header class="r-panel-head">${back}${badge}${title}${meta}<span class="r-grow"></span>${actions}${iconBtn("maximize-2", K.fullscreen)}${iconBtn("x", K.close)}</header>`;
  }

  function todoList(big) {
    return `<ul class="r-todo"${big ? " data-big" : ""}>${P.tasks.items
      .map((t) => `<li data-state="${t.state}">${t.state === "current" ? '<span class="r-dot" aria-hidden="true"></span>' : ""}${esc(t.text)}${t.state === "done" ? '<span class="r-sr">（已完成）</span>' : ""}</li>`)
      .join("")}</ul>`;
  }

  function board() {
    return `<div class="r-board">${P.extensions.board.columns
      .map(
        (c) =>
          `<div class="r-board-col"><div class="r-board-head">${esc(c.title)}</div>${c.cards.map((k) => `<div class="r-board-card"${k.current ? " data-current" : ""}>${esc(k.text)}</div>`).join("")}</div>`,
      )
      .join("")}</div>`;
  }

  const failedBody = (name, reason) =>
    `<div class="r-failed" role="alert"><span class="r-fail-text">${icon("circle-alert", 14)}${esc(name)} 加载失败</span><span class="r-muted">${esc(reason)}</span><button class="r-linkbtn">${icon("refresh", 12)}${esc(K.retry)}</button></div>`;

  function csvTable(rows, limit) {
    const [head, ...body] = rows;
    const shown = limit ? body.slice(0, limit) : body;
    return `<table class="r-ptable"><thead><tr>${head.map((h, i) => `<th${i === 3 ? ' class="r-num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${shown
      .map((r) => `<tr>${r.map((c, i) => `<td${i === 3 ? ' class="r-num"' : ""}>${esc(c)}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
  }

  function subPanelBody() {
    const SP = S.panel;
    return `<div class="r-panel-body r-subpanel"><div class="r-task"><div class="r-task-label">任务 · 主 agent 派出</div>${esc(SP.task)}</div><div class="r-tline"><span class="r-tlabel">${esc(SP.meta)}</span></div>${toolGroup(T.expanded.slice(0, 3), { forceGroup: true })}${prose(`<p>${esc(SP.prose)}</p>`)}<div class="r-tline">${spin()}<span class="r-tlabel">已使用 Acme 文档: 搜索文件 <span class="r-em">${esc(SP.current)}</span></span></div></div><footer class="r-status r-panel-status"><div class="r-status-left"><span class="r-ellipsis">${esc(SP.footer)}</span></div><div class="r-status-right"><span>上下文 ${esc(SP.context)}</span></div></footer>`;
  }

  function filePanelBody(kind) {
    if (kind === "csv" || kind === "xlsx") {
      const tabs = kind === "xlsx" ? `<div class="r-tabs" role="tablist">${FI.sheets.map((s, i) => `<span role="tab" aria-selected="${i === 0}">${esc(s)}</span>`).join("")}</div>` : "";
      const note = kind === "csv" ? '<div class="r-pnote">显示前 10 行 · 共 14 行</div>' : "";
      return `${tabs}<div class="r-panel-body" data-flush>${csvTable(P.csvRows)}${note}</div>`;
    }
    if (kind === "image") return `<div class="r-panel-body r-pimage">${chart()}</div>`;
    if (kind === "text") return `<div class="r-panel-body"><pre class="r-ptext">${esc(FI.textPreview)}</pre></div>`;
    if (kind === "markdown") return `<div class="r-panel-body">${prose(markdown(FI.markdownPreview))}</div>`;
    if (kind === "none")
      return `<div class="r-panel-body r-pnone"><div class="r-pnone-card">${typeBadge("PDF")}<div class="r-min0"><div class="r-ellipsis">${esc(FI.many[2].name)}</div><div class="r-muted r-small">${esc(FI.many[2].size)} · 没有可用的预览</div></div>${btn(K.download, "default", { icon: "download" })}</div></div>`;
    if (kind === "failed")
      return `<div class="r-panel-body r-pnone">${failedBody("预览", "预览扩展 10 秒内没有响应")}<div class="r-pnone-card">${typeBadge("PDF")}<div class="r-min0"><div class="r-ellipsis">${esc(FI.many[2].name)}</div><div class="r-muted r-small">${esc(FI.many[2].size)}</div></div>${btn(K.download, "default", { icon: "download" })}</div></div>`;
    return "";
  }

  const FILE_FOR = {
    xlsx: FI.outputs[0],
    csv: FI.many[1],
    image: FI.image,
    text: FI.many[4],
    markdown: FI.text,
    none: FI.many[2],
    failed: FI.many[2],
  };

  function filePanel(kind, o = {}) {
    const f = FILE_FOR[kind];
    const head = panelHeader({
      type: f.type,
      title: f.name,
      meta: `v${f.version ?? 1} · ${esc(FI.updated)}`,
      actions: [iconBtn("download", K.download)],
      switching: o.switching,
    });
    return `${head}${filePanelBody(kind)}`;
  }

  function switcherMenu() {
    const item = (x, checked) =>
      `<div class="r-menu-item" role="menuitemradio" aria-checked="${checked}">${x.kind === "file" ? typeBadge(x.type) : icon(x.label === "待办" ? "list-checks" : "extension", 14)}<span class="r-ellipsis">${esc(x.label)}</span></div>`;
    const ext = P.switcher.filter((x) => x.kind === "extension").map((x) => item(x, false));
    const files = P.switcher.filter((x) => x.kind === "file").map((x, i) => item(x, i === 0));
    return `<div class="r-menu r-switch-menu" role="menu"><div class="r-menu-label">扩展</div>${ext.join("")}<div class="r-menu-sep"></div><div class="r-menu-label">${esc(K.files)}</div>${files.join("")}</div>`;
  }

  function rightPanel(o) {
    let inner;
    switch (o.state) {
      case "extension":
        inner = `${panelHeader({ title: "待办", meta: `${P.tasks.done} / ${P.tasks.total}` })}<div class="r-panel-body">${todoList(true)}</div>`;
        break;
      case "file":
        inner = filePanel("xlsx");
        break;
      case "subagent": {
        const s = S.running[0];
        inner = `${panelHeader({ back: true, switcher: false, title: s.description, meta: `<span class="r-inline">${spin()}${esc(s.duration)}</span>`, actions: [btn(K.stop, "default")] })}${subPanelBody()}`;
        break;
      }
      case "switcher":
        inner = `${filePanel("xlsx", { switching: true })}${switcherMenu()}`;
        break;
      case "failed":
        inner = `${panelHeader({ title: P.extensions.failed.name })}<div class="r-panel-body r-pnone">${failedBody(P.extensions.failed.name, P.extensions.failed.reason)}</div>`;
        break;
    }
    return `<aside class="r-rpanel" aria-label="右侧面板">${inner}</aside>`;
  }

  function filePreview(o) {
    return `<aside class="r-rpanel" aria-label="文件预览">${filePanel(o.state)}</aside>`;
  }

  // ── Inline cards and property sections ─────────────────────────────────

  function inlineCard(o) {
    const todo = P.extensions.todo;
    const boardName = P.extensions.board.name;
    const name = o.state === "view" || o.state === "loading" ? todo.name : boardName;
    const count = o.state === "view" ? `<span class="r-faint">${P.tasks.done} / ${P.tasks.total}</span>` : "";
    const live = o.state === "embed" ? '<span class="r-muted">实时</span>' : "";
    const head = `<div class="r-tline r-icard-head"><span class="r-tlabel">来自 ${esc(name)} 的卡片</span><span class="r-grow"></span>${count}${live}${iconBtn("maximize-2", K.openInPanel, { step: "dense", size: 14 })}</div>`;
    let body;
    if (o.state === "view") body = todoList(false);
    else if (o.state === "embed") body = board();
    else if (o.state === "loading")
      body = `<div class="r-skel-list" aria-busy="true" aria-label="加载中">${[56, 72, 48, 64].map((w) => `<span class="r-skel" style="width:${w}%"></span>`).join("")}</div>`;
    else body = failedBody(boardName, P.extensions.failed.reason);
    return `${head}<div class="r-icard"${o.state === "embed" ? " data-embed" : ""}>${body}</div>`;
  }

  function propSection(o) {
    const sec = (title, value, body, extra = "") =>
      `<section class="r-psec"${extra}><div class="r-psec-head"><span class="r-muted">${esc(title)}</span>${value ? `<span>${value}</span>` : ""}</div>${body}</section>`;
    switch (o.state) {
      case "context": {
        const X = P.context;
        return sec("上下文", `${X.ratio}%`, `<div class="r-meter" role="meter" aria-valuenow="${X.ratio}"><span style="width:${X.ratio}%"></span></div><div class="r-muted r-small">${esc(X.model)} · ${esc(X.sandbox)}</div><div class="r-muted r-small">连接器：${X.connectors.map(esc).join("、")}</div>`);
      }
      case "files":
        return sec(
          "文件",
          `<span class="r-muted">${FI.many.length}</span>`,
          `<div class="r-plist">${FI.many.slice(0, 4).map((f) => `<a class="r-pfile" href="#">${typeBadge(f.type)}<span class="r-ellipsis">${esc(f.name)}</span><span class="r-muted">${esc(f.size)}</span></a>`).join("")}<a class="r-pmore" href="#">全部 ${FI.many.length} 个文件${icon("chevron-right", 12)}</a></div>`,
        );
      case "background": {
        const B = P.background;
        return sec(
          "后台任务",
          "",
          `${B.running.map((r) => `<div class="r-bgrow">${spin()}<span class="r-ellipsis r-grow">${esc(r.name)}</span><span class="r-muted">${esc(r.duration)}</span>${iconBtn("square", K.stop, { step: "dense", size: 12 })}</div>`).join("")}<a class="r-pmore" href="#">已完成 ${B.completed} 项${icon("chevron-right", 12)}</a>`,
        );
      }
      case "extension":
        return sec("待办", `<span class="r-muted">${P.tasks.done} / ${P.tasks.total}</span>`, todoList(false));
      case "failed":
        return sec("待办", "", failedBody("待办", "扩展 10 秒内没有响应"));
    }
    return "";
  }

  function propertiesPanel() {
    return `<aside class="r-props" aria-label="${esc(K.properties)}">${["context", "extension", "files", "background"].map((s) => propSection({ state: s })).join("")}</aside>`;
  }

  // ── Conversation template ──────────────────────────────────────────────

  function convStatus(o = {}) {
    const X = C.stats;
    const left = o.new ? "grant@示例组织:/chat" : `${C.path}`;
    const stats = o.new ? "" : `<span class="r-ellipsis">第 ${X.turns} 轮 · 已用 ${esc(X.elapsed)}</span>`;
    const right = o.new ? "" : `<span>${o.idle ? "空闲" : esc(X.status)}</span><span>上下文 ${esc(X.context)}</span>`;
    return `<footer class="r-status" role="status"><div class="r-status-left"><span class="r-ellipsis r-status-context">${esc(left)}</span>${stats}</div><div class="r-status-right">${right}<span>${esc(X.version)}</span></div></footer>`;
  }

  /** The main thread of the template blocks (canvas "Refined" conversation). */
  function thread(kind) {
    if (kind === "subagent")
      return `<div class="r-ucol"><div class="r-bubble">有需要规整的吗？</div></div>${prose("<p>文件较多，我先让子 agent 列出完整目录树，同时对照流程实际读写的文件。</p>")}<div class="r-chatcol">${subGroup({ state: "row-open" })}</div>${prose("<p>目录树还在生成，我先整理当前版本流程引用的文件和文件夹 ID……</p>")}`;
    if (kind === "file")
      return `<div class="r-ucol"><div class="r-bubble">把差异整理成表格</div></div>${toolGroup(T.done.slice(0, 3))}${prose("<p>整理好了，一共 14 行差异，按收款人汇总在第二个工作表：</p>")}${fileCard(FI.outputs[0])}`;
    return `<div class="r-ucol"><div class="r-bubble">${esc(C.user.text)}</div></div>${toolGroup(T.doneFailed.slice(0, 3))}${prose(`<p>${esc(F.PROSE_FIXTURE.streaming)}。明细整理成了表格：</p>`)}${fileCard(FI.outputs[0])}<div class="r-tline">${spin()}<span class="r-tlabel">正在核对总账<span class="r-faint"> · ${esc(C.stats.elapsed)}</span></span></div>`;
  }

  function template(o) {
    const side = sidebar({ mode: o.state === "sheet" ? "rail" : "full", activeConversation: "cnv_r1", activeTitle: C.title });
    if (o.state === "new") {
      const body = `<div class="r-conv-new"><h2 class="r-h2">${esc(C.agent.name)}</h2><p class="r-prose-small r-muted">检索资料、核对数据并整理成报告。</p>${composer({ state: "new" })}</div>`;
      return `<div class="r-app">${sidebar({ mode: "full", active: "new", activeConversation: null })}<main class="r-main"><header class="r-titlebar"><span class="r-title" data-untitled>${esc(F.NEW_CONVERSATION_LABEL)}</span></header><div class="r-conv-scroll" data-center>${body}</div>${convStatus({ new: true })}</main></div>`;
    }
    const running = o.state === "properties";
    const props = o.state === "properties" ? propertiesPanel() : "";
    const pressed = o.state === "properties" ? "properties" : o.state === "file-panel" || o.state === "sheet" ? "files" : undefined;
    const kind = o.state === "subagent-panel" ? "subagent" : o.state === "properties" ? "main" : "file";
    const center = `<div class="r-conv-center"><div class="r-conv-scroll"><div class="r-thread">${thread(kind)}</div></div><div class="r-conv-composer">${composer({ state: running ? "running" : "idle" })}</div></div>`;
    const main = `<main class="r-main r-conv-main">${titleBar({ pressed })}<div class="r-conv-cols">${center}${props}</div>${convStatus({ idle: o.state === "file-panel" || o.state === "sheet" })}</main>`;
    let panel = "";
    if (o.state === "file-panel") panel = `<aside class="r-rpanel" aria-label="文件预览">${filePanel("xlsx")}</aside>`;
    if (o.state === "subagent-panel") panel = rightPanel({ state: "subagent" });
    if (o.state === "sheet")
      panel = `<div class="r-scrim r-sheet-scrim"></div><aside class="r-rpanel r-sheet" role="dialog" aria-modal="true" aria-label="文件预览">${filePanel("xlsx")}</aside>`;
    return `<div class="r-app r-conv-app"${o.state === "sheet" ? " data-sheet" : ""}>${side}${main}${panel}</div>`;
  }

  // Each kind renders inside a 720-wide column (`.r-col-chat`) unless it is a whole frame.
  const col = (html) => `<div class="r-chatcol">${html}</div>`;

  return {
    "conv-template": template,
    "title-bar": (o) => `<div class="r-titlebar-stage">${titleBar(o)}</div>`,
    composer: (o) => col(composer(o)),
    "picker-menu": (o) => col(pickerMenu({ menu: o.state })),
    prose: (o) => col(proseBlock(o)),
    "thinking-row": (o) => col(thinking(o)),
    "user-bubble": (o) => col(userBubble(o)),
    "run-divider": (o) => col(divider(o)),
    "tool-group": (o) => {
      const rows = {
        single: null,
        running: T.running,
        collapsed: T.done,
        "collapsed-failed": T.doneFailed,
        "one-object": T.oneObject,
        expanded: T.expanded,
        edited: T.diff,
      }[o.state];
      if (o.state === "single")
        return col(`<div class="r-stack">${T.single.map((t) => toolGroup([t])).join("")}</div>`);
      return col(toolGroup(rows, { open: o.state === "expanded", openRows: o.state === "expanded" ? ["t_exp_conn", "t_exp_cmd"] : [] }));
    },
    "tool-row": (o) => {
      const pick = {
        default: [T.expanded[2], {}],
        hover: [T.expanded[2], { hover: true }],
        focus: [T.expanded[2], { focus: true }],
        running: [T.running[2], {}],
        failed: [T.expanded[3], {}],
        "expanded-command": [T.expanded[4], { open: true }],
        "expanded-connector": [T.expanded[1], { open: true }],
        "expanded-failed": [T.expanded[3], { open: true }],
        "large-output": [T.largeOutput[0], { open: true }],
        "hook-denied": [T.hookDenied[0], { open: true }],
      }[o.state];
      return col(`<div class="r-tbox">${toolRow(pick[0], pick[1])}</div>`);
    },
    "diff-block": (o) => {
      const t = T.diff[0];
      return col(`<div class="r-tline" role="button" aria-expanded="true">${toolLabel(t)}${chev(true)}</div><div class="r-tbox">${diffBlock(t, { truncated: o.state === "truncated" })}</div>`);
    },
    "approval-block": (o) => col(approval(o)),
    "question-block": (o) => col(question(o)),
    "connect-block": (o) => col(connect(o)),
    "queued-message": (o) => col(queued(o)),
    "subagent-group": (o) => col(subGroup(o)),
    "inline-card": (o) => col(inlineCard(o)),
    "property-section": (o) => `<div class="r-props">${propSection(o)}</div>`,
    "right-panel": rightPanel,
    "file-card": (o) => col(fileCardBlock(o)),
    "file-outputs": (o) => col(fileOutputs(o)),
    "attachment-strip": (o) => col(`<div class="r-composer">${attachmentStrip(o)}<div class="r-composer-input r-faint">帮我对一下这几个文件</div></div>`),
    "file-preview": filePreview,
  };
};
