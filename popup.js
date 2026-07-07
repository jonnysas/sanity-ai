(() => {
  "use strict";

  const NOTIFY_KEYS = ["chime", "notif", "badge"];
  const SITE_KEYS = ["hope", "claude", "gemini", "chatgpt", "cursor"];
  const SITES_KEY = "sites";
  const errorEl = document.getElementById("errorMsg");
  const hasStorage = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  const canMessage = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage;
  const PANEL = /(^|\/)sidepanel\.html$/.test(location.pathname); // the side panel reuses this script
  if (PANEL) document.documentElement.classList.add("panel");

  // Let the service worker know the panel is open. A port gives immediate
  // open/close signal; a periodic ping keeps the SW's view correct even after
  // it's torn down and respawned (the in-memory flag would otherwise go stale).
  if (PANEL && chrome.runtime) {
    const connectPort = () => {
      if (!chrome.runtime.connect) return;
      try {
        const port = chrome.runtime.connect({ name: "sanity-panel" });
        port.onDisconnect.addListener(() => { setTimeout(connectPort, 1000); }); // SW recycled → reconnect
      } catch (e) {}
    };
    connectPort();
    const ping = () => { try { chrome.runtime.sendMessage({ type: "panelPing" }); } catch (e) {} };
    ping();
    setInterval(ping, 4000);
  }

  // Gear: reveal/hide settings (the panel is a clean live monitor by default).
  (function () {
    const gearBtn = document.getElementById("gearBtn");
    if (!gearBtn) return;
    gearBtn.addEventListener("click", () => {
      const open = document.documentElement.classList.toggle("settings-open");
      gearBtn.classList.toggle("active", open);
      if (open) gearBtn.scrollIntoView({ block: "nearest" });
    });
  })();

  function showError(msg) { if (errorEl) { errorEl.textContent = msg; errorEl.style.display = "block"; } }

  // ════════ Live overview ════════
  function rel(ts, kind) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (kind === "run") {
      if (s < 60) return "running";
      const m = Math.floor(s / 60);
      return m < 60 ? `running ${m}m` : `running ${Math.floor(m / 60)}h`;
    }
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    return Math.round(m / 60) + "h ago";
  }

  function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }

  // Compact duration for the meta-line readouts: minute precision reads
  // calmer than "18m 50s", and the exact figure lives in the tooltip.
  function fmtDurShort(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.round(s / 60);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }

  // Live ticking clock for running items (M:SS / H:MM:SS).
  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
  }

  // Tool identity — color + glyph so you scan the fleet by tool at a glance.
  function toolStyle(it) {
    const s = (it.site || "").toLowerCase(), h = (it.host || "").toLowerCase();
    if (h.includes("bit.cloud") || s.includes("hope")) return { grad: true, ring: "#b06ad6", glyph: "H" };
    if (s.includes("claude") || h.includes("claude")) return { color: "#d97757", ring: "#d97757", glyph: "C" };
    if (s.includes("gemini") || h.includes("gemini")) return { color: "#4285f4", ring: "#4285f4", glyph: "\u2726" };
    if (s.includes("chatgpt") || h.includes("openai") || h.includes("chatgpt")) return { color: "#10a37f", ring: "#10a37f", glyph: "G" };
    if (s.includes("cursor") || h.includes("cursor")) return { color: "#6b7280", ring: "#6b7280", glyph: "\u203A" };
    return { color: "#6366f1", ring: "#6366f1", glyph: "\u2022" };
  }

  // The mark at rest: a soft sun settling behind a still horizon (echoes the icon).
  const SPARKLE = '<svg viewBox="0 0 48 48">' +
    '<defs><radialGradient id="ob" cx="0.42" cy="0.38" r="0.75">' +
    '<stop offset="0" stop-color="#b9b4ee"/><stop offset="1" stop-color="#7c77c9"/></radialGradient>' +
    '<clipPath id="obc"><rect x="0" y="0" width="48" height="29.5"/></clipPath></defs>' +
    '<circle cx="24" cy="23" r="10" fill="url(#ob)" clip-path="url(#obc)"/>' +
    '<line x1="8" y1="29.5" x2="40" y2="29.5" stroke="#a9a3de" stroke-width="1.5" stroke-linecap="round" opacity="0.55"/>' +
    '<line x1="18.5" y1="34.5" x2="29.5" y2="34.5" stroke="#a9a3de" stroke-width="1.5" stroke-linecap="round" opacity="0.3"/></svg>';

  let liveRunEls = [];   // running time spans to tick each second
  let tickTimer = null;
  let prevKeys = new Set(); // for enter animations
  let panelEnabled = true;
  let panelOpenNow = false;
  let gotState = false;       // don't reveal the "Open side panel" CTA until we know panel state
  let recentExpanded = false; // "Recently finished" shows up to 6, then expands
  let lastState = null;
  let customLabels = {};      // { [convId]: "custom display name" }
  let starred = {};           // { [convId]: true } — highlighted sessions

  // A session's stable identity: host + path (survives tab id changes / reopen).
  function convOf(it) {
    try { const u = new URL(it.url); return u.host + u.pathname; } catch (e) { return (it.host || "") + ":" + it.tabId; }
  }
  function displayName(it) {
    const key = convOf(it);
    return (customLabels[key] && customLabels[key].trim()) || it.title || it.site || "Session";
  }
  function persistLabels() { try { chrome.storage.local.set({ labels: customLabels }); } catch (e) {} }
  function persistStarred() { try { chrome.storage.local.set({ starred }); } catch (e) {} }

  function makeItem(it, kind) {
    const row = document.createElement("div");
    row.className = "item";
    if (it.host === "bit.cloud" || it.site === "Hope AI") row.classList.add("hope");
    if (starred[convOf(it)]) row.classList.add("starred");
    row.dataset.key = kind + ":" + it.tabId;
    row.setAttribute("role", "button");
    row.tabIndex = 0;

    // Avatar = tool identity (color + glyph); running state shows a pulsing ring.
    const av = document.createElement("span");
    av.className = "avatar" + (kind === "run" ? " run" : kind === "recent" ? " recent" : kind === "input" ? " input" : "");
    const ts = toolStyle(it);
    av.style.background = ts.grad ? "linear-gradient(135deg, #6d5efc, #c43cdb)" : ts.color;
    av.style.setProperty("--ring", ts.ring);
    av.textContent = ts.glyph;

    const body = document.createElement("div");
    body.className = "item-body";
    const title = document.createElement("div");
    title.className = "item-title";
    title.textContent = displayName(it);
    title.title = title.textContent;
    const meta = document.createElement("div");
    meta.className = "item-meta";
    const site = document.createElement("span");
    site.className = "site";
    site.textContent = it.site || it.host || "";
    const time = document.createElement("span");
    if (kind === "run") {
      time.textContent = " · running " + clock(Date.now() - it.ts);
      liveRunEls.push({ el: time, ts: it.ts });
    } else {
      time.textContent = " · " + rel(it.ts, kind);
    }
    meta.append(site, time);
    body.append(title, meta);

    const go = () => { if (canMessage) chrome.runtime.sendMessage({ type: "focusTab", tabId: it.tabId, url: it.url }); if (!PANEL) window.close(); };
    row.addEventListener("click", go);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    row.append(av, body);

    // Time-to-complete chips: last turn (clock) + cumulative across turns (Σ).
    if ((kind === "wait" || kind === "recent") && it.durationMs) {
      const multi = it.turns > 1 && it.totalMs;
      const dur = document.createElement("span");
      dur.className = "dur";
      dur.title = (multi ? "This turn: " : "Time to complete: ") + fmtDur(it.durationMs);
      dur.innerHTML =
        '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<circle cx="12" cy="13" r="8" stroke="currentColor" stroke-width="2"/>' +
        '<path d="M12 9v4l2.5 1.5M9 2h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' +
        '<span></span>';
      dur.lastChild.textContent = fmtDurShort(it.durationMs);
      meta.append(dur); // on the meta line: the title never yields width to a chip
      if (multi) {
        const tot = document.createElement("span");
        tot.className = "dur total";
        tot.title = "Total across " + it.turns + " turns: " + fmtDur(it.totalMs);
        tot.innerHTML = '<span class="sig">\u03A3</span><span></span>';
        tot.lastChild.textContent = fmtDurShort(it.totalMs);
        meta.append(tot);
      }
    }

    // ── Per-item controls: highlight (star), rename (pencil), and dismiss/clear ──
    const controls = document.createElement("div");
    controls.className = "controls";

    const key = convOf(it);
    const star = document.createElement("button");
    star.className = "icon-btn star" + (starred[key] ? " on" : "");
    star.title = starred[key] ? "Remove highlight" : "Highlight this session";
    star.setAttribute("aria-label", star.title);
    star.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
    star.addEventListener("click", (e) => {
      e.stopPropagation();
      if (starred[key]) delete starred[key]; else starred[key] = true;
      persistStarred();
      renderLive(lastState);
    });

    const edit = document.createElement("button");
    edit.className = "icon-btn edit";
    edit.title = "Rename"; edit.setAttribute("aria-label", "Rename");
    edit.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
    edit.addEventListener("click", (e) => { e.stopPropagation(); startRename(it, title, row); });

    controls.append(star, edit);

    if (kind === "wait" || kind === "input") {
      const x = document.createElement("button");
      x.className = "icon-btn x"; x.textContent = "\u2715"; x.title = "Dismiss"; x.setAttribute("aria-label", "Dismiss");
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        if (canMessage) chrome.runtime.sendMessage({ type: "dismiss", tabId: it.tabId }, (st) => renderLive(st));
      });
      controls.append(x);
    } else if (kind === "recent") {
      const x = document.createElement("button");
      x.className = "icon-btn x"; x.textContent = "\u2715"; x.title = "Clear this one"; x.setAttribute("aria-label", "Clear this one");
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        if (canMessage) chrome.runtime.sendMessage({ type: "clearHistoryItem", ts: it.ts, tabId: it.tabId }, (st) => renderLive(st));
      });
      controls.append(x);
    }
    row.append(controls);
    return row;
  }

  // Inline rename: swap the title for an input; Enter saves, Esc cancels.
  function startRename(it, titleEl, row) {
    const key = convOf(it);
    const input = document.createElement("input");
    input.className = "rename-input";
    input.value = customLabels[key] || it.title || "";
    input.placeholder = it.title || "Name this session";
    input.maxLength = 80;
    titleEl.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const commit = (save) => {
      if (done) return; done = true;
      if (save) {
        const v = input.value.trim();
        if (v && v !== it.title) customLabels[key] = v; else delete customLabels[key];
        persistLabels();
      }
      renderLive(lastState);
    };
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", () => commit(true));
  }

  function block(label, count, items, kind) {
    const wrap = document.createElement("div");
    wrap.className = "live-block " + kind;
    const eb = document.createElement("div");
    eb.className = "eyebrow " + kind;
    const lab = document.createElement("span");
    lab.className = "eb-label";
    lab.innerHTML = `${label} <span class="n">${count}</span>`;
    eb.appendChild(lab);
    if (kind === "recent") {
      const clear = document.createElement("button");
      clear.className = "clear-btn";
      clear.textContent = "Clear";
      clear.title = "Clear the recently-finished log";
      clear.addEventListener("click", (e) => {
        e.stopPropagation();
        if (canMessage) chrome.runtime.sendMessage({ type: "clearHistory" }, (st) => renderLive(st));
      });
      eb.appendChild(clear);
    }
    const card = document.createElement("div");
    card.className = "live-card " + kind;
    const LIMIT = 6;
    const shown = (kind === "recent" && !recentExpanded) ? items.slice(0, LIMIT) : items;
    shown.forEach((it) => card.appendChild(makeItem(it, kind)));
    wrap.append(eb, card);
    if (kind === "recent" && items.length > LIMIT) {
      const more = document.createElement("button");
      more.className = "show-more";
      more.textContent = recentExpanded ? "Show less" : ("Show " + (items.length - LIMIT) + " more");
      more.addEventListener("click", (e) => { e.stopPropagation(); recentExpanded = !recentExpanded; renderLive(lastState); });
      wrap.appendChild(more);
    }
    return wrap;
  }

  function startTicker() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (!liveRunEls.length) return;
    const tick = () => { const now = Date.now(); liveRunEls.forEach((o) => { o.el.textContent = " · running " + clock(now - o.ts); }); };
    tickTimer = setInterval(tick, 1000);
  }

  // Reassurance line — the emotional core: the one thing that needs you,
  // or explicit permission to look away.
  function renderStatus(running, waiting, blocked) {
    const el = document.getElementById("status");
    if (!el) return;
    el.innerHTML = "";
    let tone = "", strong = "", rest = "";
    const restParts = [];
    if (blocked > 0) {
      tone = "input";
      strong = blocked + (blocked === 1 ? " needs a word from you" : " need a word from you");
      if (waiting > 0) restParts.push(waiting + " ready");
      if (running > 0) restParts.push(running + " still working");
      rest = restParts.length ? "  ·  " + restParts.join("  ·  ") : "";
    } else if (waiting > 0) {
      tone = "wait";
      strong = waiting + " ready for you";
      if (running > 0) restParts.push(running + " still working");
      rest = restParts.length ? "  ·  " + restParts.join("  ·  ") : "";
    } else if (running > 0) {
      tone = "run";
      strong = running + (running === 1 ? " agent working" : " agents working");
      rest = " — I\u2019ll chime when " + (running === 1 ? "it\u2019s" : "they\u2019re") + " done.";
    } else { el.style.display = "none"; return; }
    el.style.display = "";
    el.className = "status " + tone;
    const a = document.createElement("span"); a.className = "s-strong"; a.textContent = strong;
    const b = document.createElement("span"); b.className = "s-rest"; b.textContent = rest;
    el.append(a, b);
  }

  function updateCtaVisibility() {
    if (PANEL) return;
    document.querySelectorAll(".open-panel").forEach((el) => {
      el.style.display = (gotState && panelEnabled && !panelOpenNow) ? "" : "none";
    });
  }

  // The exhale line: when the fleet is empty, quietly total what the agents
  // did today — the moment of nothing-to-do becomes proof the system worked.
  function appendTodayLine(card) {
    if (!hasStorage || !card) return;
    chrome.storage.local.get("stats", (r) => {
      if (chrome.runtime.lastError) return;
      const stats = r && r.stats;
      const day = new Date().toISOString().slice(0, 10);
      const d = stats && stats.days && stats.days[day];
      if (!d || !d.ms || d.ms < 60000 || !card.isConnected) return;
      const el = document.createElement("div");
      el.className = "today";
      el.textContent = "Your agents worked " + fmtDur(d.ms) + " for you today.";
      card.appendChild(el);
    });
  }

  function renderLive(state) {
    const live = document.getElementById("live");
    if (!live) return;
    const running = (state && state.running) || [];
    const waiting = (state && state.waiting) || [];
    const blocked = (state && state.blocked) || [];
    const history = (state && state.history) || [];
    panelOpenNow = !!(state && state.panelOpen);
    gotState = true;
    lastState = state;
    liveRunEls = [];

    renderStatus(running.length, waiting.length, blocked.length);
    updateCtaVisibility();
    live.textContent = "";

    // De-dupe surfaces: if the panel is already showing the live fleet, the
    // popup steps back to settings instead of repeating the list.
    if (!PANEL && panelOpenNow) {
      const note = document.createElement("div");
      note.className = "panel-open-note";
      note.innerHTML = '<span>Already on it — your fleet is live in the side panel.</span>';
      live.appendChild(note);
      startTicker();
      return;
    }

    if (!running.length && !waiting.length && !blocked.length && !history.length) {
      live.innerHTML =
        '<div class="clear"><div class="mark">' + SPARKLE + '</div>' +
        '<div class="big">All quiet.</div>' +
        '<div class="sub">Nothing needs you right now.</div></div>';
      appendTodayLine(live.querySelector(".clear"));
      prevKeys = new Set();
      startTicker();
      return;
    }

    // Order by urgency: what needs you first, then ambient, then reference.
    if (blocked.length) live.appendChild(block("Needs your input", blocked.length, blocked, "input"));
    if (waiting.length) live.appendChild(block("Ready for you", waiting.length, waiting, "wait"));
    if (running.length) live.appendChild(block("Running", running.length, running, "run"));
    if (history.length) live.appendChild(block("Done earlier", history.length, history, "recent"));

    // Animate only genuinely new rows (so peripheral vision catches changes).
    const curKeys = new Set();
    live.querySelectorAll(".item").forEach((el) => {
      const k = el.dataset.key;
      curKeys.add(k);
      if (!prevKeys.has(k)) el.classList.add("enter");
    });
    prevKeys = curKeys;
    startTicker();
  }

  function loadLive() {
    const render = (st) => renderLive(st);
    const fetchState = () => {
      if (!canMessage) { render({ running: [], waiting: [], history: [] }); return; }
      chrome.runtime.sendMessage({ type: "getState" }, (st) => {
        if (chrome.runtime.lastError) { render({ running: [], waiting: [], history: [] }); return; }
        render(st);
      });
    };
    // Personalization (custom names + highlighted sessions) lives in local storage.
    if (chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(["labels", "starred"], (r) => {
        customLabels = (r && r.labels) || {};
        starred = (r && r.starred) || {};
        fetchState();
      });
    } else { fetchState(); }
  }
  loadLive();
  renderHopeCtl();
  renderWeek();
  renderStats();

  // ── Usage & data: per-site lifetime summary + CSV export (local-only) ──
  function fmtAvg(v) { const s = Math.round(v / 1000); if (s < 60) return s + "s"; const m = Math.floor(s / 60); return m + "m " + (s % 60) + "s"; }
  function renderStats() {
    const box = document.getElementById("statsSummary");
    if (!box || !hasStorage) return;
    chrome.storage.local.get(SAN.KEYS.SITE_STATS, (r) => {
      if (chrome.runtime.lastError) return;
      const agg = (r && r[SAN.KEYS.SITE_STATS]) || {};
      const rows = Object.values(agg).filter((a) => a && a.runs > 0)
        .sort((a, b) => b.runs - a.runs);
      if (!rows.length) { box.innerHTML = '<div class="ss-empty">No runs yet — hand something off and I’ll start counting.</div>'; return; }
      box.innerHTML = rows.map((a) => {
        const name = a.site || "Other";
        const avg = a.runs ? a.totalMs / a.runs : 0;
        const start = a.startRuns ? ' · starts in <b>' + fmtAvg(a.startTotalMs / a.startRuns) + '</b>' : "";
        return '<div class="ss-row"><span class="ss-name">' + esc(name) + '</span>' +
          '<span class="ss-meta"><b>' + a.runs + '</b> run' + (a.runs === 1 ? "" : "s") +
          ' · avg <b>' + fmtAvg(avg) + '</b> · longest <b>' + fmtAvg(a.longestMs) + '</b>' + start + '</span></div>';
      }).join("");
    });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])); }

  // CSV: quote every field, double internal quotes (safe for titles with commas).
  function csvCell(v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }
  function exportCsv() {
    if (!hasStorage) { showError("Storage unavailable — can't export."); return; }
    chrome.storage.local.get(SAN.KEYS.RUN_LOG, (r) => {
      if (chrome.runtime.lastError) { showError("Couldn't read the run log."); return; }
      const log = (r && r[SAN.KEYS.RUN_LOG]) || [];
      if (!log.length) { showError("No runs to export yet."); return; }
      const header = ["timestamp", "date_iso", "tool", "host", "title", "prompt", "duration_ms", "duration_s", "time_to_start_ms", "conversation_total_ms", "turns"];
      const lines = [header.map(csvCell).join(",")];
      for (const e of log) {
        lines.push([
          e.ts, new Date(e.ts).toISOString(), e.site || "", e.host || "", e.title || "",
          e.prompt || "",
          e.durationMs || 0, ((e.durationMs || 0) / 1000).toFixed(1),
          (typeof e.startMs === "number" ? e.startMs : ""),
          e.totalMs || 0, e.turns || 1,
        ].map(csvCell).join(","));
      }
      const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "sanity-runs-" + new Date().toISOString().slice(0, 10) + ".csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
  }
  const expBtn = document.getElementById("exportCsvBtn");
  if (expBtn) expBtn.addEventListener("click", exportCsv);

  // "This week" — local stats card (runs · agent time · longest).
  function renderWeek() {
    const box = document.getElementById("weekCard");
    if (!box || !hasStorage) return;
    chrome.storage.local.get("stats", (r) => {
      if (chrome.runtime.lastError) return;
      const stats = r && r.stats;
      if (!stats || !stats.days) { box.style.display = "none"; return; }
      let runs = 0, ms = 0;
      const cutoff = Date.now() - 7 * 86400000;
      for (const [day, d] of Object.entries(stats.days)) {
        if (new Date(day + "T00:00:00Z").getTime() >= cutoff) { runs += d.runs || 0; ms += d.ms || 0; }
      }
      if (!runs) { box.style.display = "none"; return; }
      const fmt = (v) => { const s = Math.round(v / 1000); if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m"; const h = Math.floor(m / 60); return h + "h " + (m % 60) + "m"; };
      let html = '<span class="wk-label">GIVEN BACK</span><span><b>' + runs + '</b> run' + (runs === 1 ? "" : "s") + '</span><span>\u00B7</span><span><b>' + fmt(ms) + '</b> you didn\u2019t have to watch</span>';
      if (stats.longest && stats.longest.ms > 0) html += '<span>\u00B7</span><span>longest <b>' + fmt(stats.longest.ms) + '</b>' + (stats.longest.site ? ' (' + stats.longest.site + ')' : '') + '</span>';
      box.innerHTML = html;
      box.style.display = "";
    });
  }

  // Custom sites + Hope reading control live in js/sites.js and js/hopectl.js.
  window.SanityMods && window.SanityMods.initSites && window.SanityMods.initSites({ canMessage });
  var _hopeCtl = null; // var (not let/const): renderHopeCtl below is hoisted and may run first
  function renderHopeCtl() {
    if (!_hopeCtl && window.SanityMods && window.SanityMods.initHopeCtl) {
      _hopeCtl = window.SanityMods.initHopeCtl({ canMessage });
    }
    if (_hopeCtl) _hopeCtl.render();
  }

  const fb = document.getElementById("expFeedback");
  if (fb) fb.addEventListener("click", (e) => {
    e.preventDefault();
    const body = "What I tried:%0A%0AWhat worked / didn't:%0A%0AIdeas:%0A";
    window.open("mailto:?subject=" + encodeURIComponent("Sanity — experiments feedback") + "&body=" + body, "_blank");
  });

  // Live refresh while the popup is open: react to queue changes + tick the clock.
  if (chrome.storage && chrome.storage.session && chrome.storage.session.onChanged) {
    let t = null;
    chrome.storage.session.onChanged.addListener((changes) => {
      if (changes.hopeReading || changes.hopeCmd) renderHopeCtl();
      const fleet = Object.keys(changes || {}).filter((k) => k !== "toast" && k !== "hopeReading" && k !== "hopeCmd");
      if (fleet.length === 0) return; // non-fleet broadcast — don't re-pull the list
      clearTimeout(t); t = setTimeout(loadLive, 120);
    });
  }
  setInterval(() => { loadLive(); renderHopeCtl(); renderWeek(); renderStats(); }, 8000); // keep timers live + control fresh

  // ════════ Collapsible sections (collapsed by default) ════════
  document.querySelectorAll(".collapsible").forEach((sec) => {
    const head = sec.querySelector(".col-head");
    head.addEventListener("click", () => {
      const open = sec.classList.toggle("open");
      head.setAttribute("aria-expanded", String(open));
    });
  });

  // ════════ Settings ════════
  function save(obj) {
    if (!hasStorage) { showError("Storage unavailable — change not saved."); return; }
    chrome.storage.local.set(obj, () => { if (chrome.runtime.lastError) showError("Couldn't save: " + chrome.runtime.lastError.message); });
  }

  function wire(saved) {
    for (const key of NOTIFY_KEYS) {
      const el = document.getElementById(key);
      if (!el) continue;
      el.checked = saved[key] !== undefined ? !!saved[key] : true;
      el.addEventListener("change", () => save({ [key]: el.checked }));
    }
    const sites = (saved[SITES_KEY] && typeof saved[SITES_KEY] === "object") ? { ...saved[SITES_KEY] } : {};
    for (const name of SITE_KEYS) {
      const el = document.getElementById("site-" + name);
      if (!el) continue;
      el.checked = sites[name] !== false;
      el.addEventListener("change", () => { sites[name] = el.checked; save({ [SITES_KEY]: sites }); });
    }

    const collapseEl = document.getElementById("collapse");
    if (collapseEl) {
      collapseEl.checked = saved.collapse === true; // experimental — off by default
      collapseEl.addEventListener("change", () => save({ collapse: collapseEl.checked }));
    }

    const panelEl = document.getElementById("panel");
    if (panelEl) {
      panelEl.checked = saved.panel !== false; // default on
      panelEnabled = panelEl.checked;
      panelEl.addEventListener("change", () => { panelEnabled = panelEl.checked; save({ panel: panelEl.checked }); updateCtaVisibility(); });
    }
    panelEnabled = saved.panel !== false;
    updateCtaVisibility();
  }

  if (hasStorage) {
    chrome.storage.local.get([...NOTIFY_KEYS, SITES_KEY, "panel", "collapse"], (res) => {
      if (chrome.runtime.lastError) { showError("Couldn't load settings."); wire({}); return; }
      wire(res || {});
    });
  } else { wire({}); }

  // ════════ Open side panel (popup only) ════════
  function openSidePanel() {
    if (panelOpenNow) { window.close(); return; } // already open — don't spawn a second (windowed) panel
    if (!(chrome.sidePanel && chrome.windows)) { showError("Side panel isn't available in this browser."); return; }
    chrome.windows.getCurrent((w) => {
      try { chrome.sidePanel.open({ windowId: w.id }); } catch (e) { showError("Couldn't open the panel."); }
      window.close();
    });
  }
  if (PANEL) {
    document.querySelectorAll(".open-panel").forEach((el) => { el.style.display = "none"; });
  } else {
    document.querySelectorAll(".open-panel").forEach((el) => el.addEventListener("click", openSidePanel));
  }

  // ════════ Test chime (runs inside a click, so audio is allowed) ════════
  const testBtn = document.getElementById("testBtn");
  if (testBtn) testBtn.addEventListener("click", () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const play = () => {
        const now = ctx.currentTime;
        const notes = [{ f: 523.25, d: 0 }, { f: 659.25, d: 0.12 }, { f: 783.99, d: 0.24 }];
        const vols = [0.25, 0.22, 0.18];
        notes.forEach(({ f, d }, i) => {
          const osc = ctx.createOscillator(), gain = ctx.createGain();
          osc.type = "sine"; osc.frequency.value = f;
          gain.gain.setValueAtTime(0, now + d);
          gain.gain.linearRampToValueAtTime(vols[i], now + d + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.001, now + d + 0.8);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + d); osc.stop(now + d + 0.9);
        });
        setTimeout(() => ctx.close(), 2000);
      };
      ctx.state === "suspended" ? ctx.resume().then(play) : play();
    } catch (e) { showError("Chime failed: " + e.message); }
  });
})();
