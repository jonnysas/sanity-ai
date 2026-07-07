importScripts("constants.js");

// Sanity — background service worker (MV3)
//
// Owns everything that must work while the agent's tab is backgrounded:
//   • OS notifications        -> chrome.notifications
//   • completion chime        -> offscreen document (AUDIO_PLAYBACK)
//   • the "waiting for you" queue + count badge on the toolbar icon
//
// The queue is the source of truth for "which finished tabs haven't I been
// back to yet." It lives in chrome.storage.session so it survives the SW being
// torn down and respawned, but resets when the browser closes (stale tab ids).
// The on-the-tab ✅ marker is handled by the content script (only the page can
// edit its own title); the toolbar count mirrors the same queue.

const NOTIF_PREFIX = "sanity-done-";
const WAIT_KEY = "waiting"; // session: { [tabId]: {title, site, host, windowId, ts} }
const RUN_KEY = "running";  // session: { [tabId]: {title, site, host, ts} }
const BLOCK_KEY = "blocked"; // session: { [tabId]: {title, site, host, url, windowId, ts} } — paused, needs the user's input
const lastDone = new Map();    // tabId -> ts of last completion (coalesces flapping)
const DONE_DEBOUNCE_MS = 4000; // duplicate "done" within this window = one completion
const STALE_RUN_MS = 150000;   // a "running" tab silent this long (no heartbeat) is dropped (tolerates background timer throttling)
const ICON = chrome.runtime.getURL("icon128.png");
// Session storage stays TRUSTED_ONLY (the default): content scripts can't read
// the fleet state. Toasts go to the active tab as a targeted message instead.

async function broadcastToast(t) {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs && tabs[0];
    if (tab && typeof tab.id === "number") {
      chrome.tabs.sendMessage(tab.id, { type: SAN.MSG.TOAST, ...t, ts: Date.now() }, () => void chrome.runtime.lastError);
    }
  } catch (e) {}
}

// ── Offscreen audio ───────────────────────────────────────────
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play a short chime when an AI agent finishes working.",
  });
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}
async function playChime() {
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ target: "offscreen", type: "play-chime" }).catch(() => {});
  } catch (e) {
    console.warn("[Sanity] chime failed:", e && e.message);
  }
}

// ── Notifications ─────────────────────────────────────────────
// Primary path is chrome.notifications (reliable OS banners + click handling on
// Chrome/Brave/etc). We fall back to an offscreen Web Notification for any
// browser where the native API is missing or no-ops (the original Dia path).
const NOTIF_URLS_KEY = "notifUrls"; // session: { [notifId]: url } — so a click can reopen a closed tab
const HAS_NOTIFICATIONS = !!(chrome.notifications && chrome.notifications.create);
async function clearForTab(tabId) {
  if (typeof tabId !== "number") return;
  const notifId = NOTIF_PREFIX + tabId;
  try { if (HAS_NOTIFICATIONS) chrome.notifications.clear(notifId); } catch (e) {}
  try {
    const r = await chrome.storage.session.get(NOTIF_URLS_KEY);
    const map = r[NOTIF_URLS_KEY] || {};
    if (notifId in map) { delete map[notifId]; await chrome.storage.session.set({ [NOTIF_URLS_KEY]: map }); }
  } catch (e) {}
  try {
    if (await chrome.offscreen.hasDocument()) {
      chrome.runtime.sendMessage({ target: "offscreen", type: "close-notification", tabId }).catch(() => {});
    }
  } catch (e) {}
}
function fmtDur(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}
async function notifyDone(tabId, title, durationMs, url) {
  await clearForTab(tabId);
  const name = (title || "").trim();
  const finished = durationMs ? `Finished in ${fmtDur(durationMs)}` : "Finished";
  const notifTitle = name || "Your agent finished";
  const notifBody = name ? `${finished} — click to jump back.` : `${finished} — ready for you.`;
  const notifId = NOTIF_PREFIX + tabId;

  // Primary: native OS notification.
  if (HAS_NOTIFICATIONS) {
    try {
      const r = await chrome.storage.session.get(NOTIF_URLS_KEY);
      const map = r[NOTIF_URLS_KEY] || {};
      map[notifId] = url || "";
      await chrome.storage.session.set({ [NOTIF_URLS_KEY]: map });
      const ok = await new Promise((resolve) => {
        try {
          chrome.notifications.create(notifId, {
            type: "basic", iconUrl: ICON, title: notifTitle, message: notifBody, priority: 1,
          }, () => resolve(!chrome.runtime.lastError));
        } catch (e) { resolve(false); }
      });
      if (ok) return true; // native worked — done
    } catch (e) { /* fall through */ }
  }

  // Fallback: offscreen Web Notification (browsers where the native API no-ops).
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({
      target: "offscreen", type: "show-notification",
      title: notifTitle, body: notifBody, icon: ICON, tabId, url,
    });
    return !!(res && res.shown);
  } catch (e) {
    console.warn("[Sanity] notification failed:", e && e.message);
    return false;
  }
}

// ── Waiting queue + count badge ───────────────────────────────
async function getWaiting() {
  const r = await chrome.storage.session.get(WAIT_KEY);
  return r[WAIT_KEY] || {};
}
async function setWaiting(w) {
  await chrome.storage.session.set({ [WAIT_KEY]: w });
}
async function badgeEnabled() {
  const r = await chrome.storage.local.get("badge");
  return r.badge !== false; // default on
}
// ── Needs-input store (agents paused for the user's approval) ──
async function getBlocked() {
  const r = await chrome.storage.session.get(BLOCK_KEY);
  return r[BLOCK_KEY] || {};
}
async function setBlocked(b) { await chrome.storage.session.set({ [BLOCK_KEY]: b }); }
async function addBlocked(tabId, entry) {
  if (typeof tabId !== "number") return;
  const b = await getBlocked();
  const isNew = !b[tabId];
  b[tabId] = { ...(b[tabId] || {}), ...entry, ts: Date.now() };
  await setBlocked(b);
  await renderBadge();
  return isNew;
}
async function removeBlocked(tabId) {
  const b = await getBlocked();
  if (b[tabId]) { delete b[tabId]; await setBlocked(b); await renderBadge(); }
}
async function listBlocked() {
  const b = await getBlocked();
  const ids = Object.keys(b);
  const alive = await Promise.allSettled(ids.map((id) => chrome.tabs.get(Number(id))));
  let changed = false;
  ids.forEach((id, i) => { if (alive[i].status === "rejected") { delete b[id]; changed = true; } });
  if (changed) { await setBlocked(b); await renderBadge(); }
  return Object.entries(b).map(([tabId, v]) => ({ tabId: Number(tabId), ...v })).sort((a, b2) => b2.ts - a.ts);
}
async function renderBadge() {
  const [w, b, on] = await Promise.all([getWaiting(), getBlocked(), badgeEnabled()]);
  const nWait = Object.keys(w).length, nBlock = Object.keys(b).length;
  const n = nWait + nBlock;
  if (on && n > 0) {
    // Amber when something needs your input; green when things are simply done.
    chrome.action.setBadgeBackgroundColor({ color: nBlock > 0 ? "#f59e0b" : "#22c55e" });
    chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
    chrome.action.setBadgeText({ text: String(n) });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}
async function addWaiting(tabId, entry) {
  if (typeof tabId !== "number") return;
  const w = await getWaiting();
  w[tabId] = { ...entry, ts: Date.now() };
  await setWaiting(w);
  await renderBadge();
}
async function removeWaiting(tabId) {
  const w = await getWaiting();
  if (w[tabId]) { delete w[tabId]; await setWaiting(w); }
  await renderBadge();
}
// Return the queue as a sorted array, dropping tabs that no longer exist.
async function listWaiting() {
  const w = await getWaiting();
  const ids = Object.keys(w);
  const alive = await Promise.allSettled(ids.map((id) => chrome.tabs.get(Number(id))));
  let changed = false;
  ids.forEach((id, i) => { if (alive[i].status === "rejected") { delete w[id]; changed = true; } });
  if (changed) { await setWaiting(w); await renderBadge(); }
  return Object.entries(w)
    .map(([tabId, v]) => ({ tabId: Number(tabId), ...v }))
    .sort((a, b) => b.ts - a.ts); // newest first
}
// Raise a window and report whether the raise actually took. On Chromium forks
// (Dia/Arc) — and on any Chromium when the call comes from a background service
// worker while another app is frontmost — chrome.windows.update({focused:true})
// is a documented no-op that degrades to a dock bounce (Chrome 13+, WontFix).
// getLastFocused is the best available signal that the OS honored the raise; it
// can false-positive, so treat `true` as "probably" and `false` as "definitely
// didn't" — the caller only escalates on a definite miss.
async function focusWindow(winId) {
  if (typeof winId !== "number") return false;
  try {
    const win = await chrome.windows.get(winId);
    const upd = { focused: true };
    if (win && win.state === "minimized") upd.state = "normal"; // can't focus a minimized window
    await chrome.windows.update(winId, upd);
  } catch (e) { try { await chrome.windows.update(winId, { focused: true }); } catch (e2) {} }
  try {
    const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    return !!(last && last.id === winId);
  } catch (e) { return false; }
}

// The window the user is actually looking at — the move target for the fallback.
async function currentWindowId() {
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (w && typeof w.id === "number") return w.id;
  } catch (e) {}
  return (typeof focusedWindowId === "number" && focusedWindowId !== chrome.windows.WINDOW_ID_NONE)
    ? focusedWindowId : null;
}

async function focusTab(tabId, url) {
  const w = await getWaiting();
  const entry = w[tabId];
  const reopen = url || (entry && entry.url);
  let action = "none";
  try {
    // Resolve the tab's *current* window (it may have moved since we recorded it).
    const t = await chrome.tabs.get(tabId); // throws if the tab is gone
    const winId = (t && typeof t.windowId === "number") ? t.windowId : (entry && entry.windowId);
    const here = await currentWindowId();

    if (typeof winId === "number" && here !== null && winId === here) {
      // Already in the window you're looking at — just select the tab.
      await chrome.tabs.update(tabId, { active: true });
      action = "activate";
    } else {
      // Cross-window. Activate the tab, then try the native window raise —
      // a clean jump on real Chrome, which preserves your window layout.
      await chrome.tabs.update(tabId, { active: true });
      const raised = await focusWindow(winId);
      if (!raised && here !== null) {
        // The raise didn't take (Dia/Arc no-op). Bring the tab to you instead:
        // relocate it into the window you're in, then activate. Sidesteps the
        // window-focus limitation entirely.
        try {
          await chrome.tabs.move(tabId, { windowId: here, index: -1 });
          await chrome.tabs.update(tabId, { active: true });
          action = "moved";
        } catch (e) {
          if (reopen) { try { await chrome.tabs.create({ windowId: here, url: reopen, active: true }); action = "reopened"; } catch (e2) {} }
        }
      } else if (typeof winId === "number") {
        action = "raised";
        // Re-assert once: if the click came from the popup, the popup closes
        // right about now and Chrome hands focus back to the popup's own window.
        setTimeout(() => { focusWindow(winId); }, 150);
      }
      // Low-noise trace so the fork behavior is confirmable from the SW console.
      try { console.debug("[Sanity] focusTab", { winId, here, raised, action }); } catch (e) {}
    }
  } catch (e) {
    // Tab was closed — reopen the conversation in a new tab if we know its URL.
    if (reopen) { try { await chrome.tabs.create({ url: reopen, active: true }); } catch (e2) {} }
  }
  clearForTab(tabId);
  await removeWaiting(tabId);
  return { ok: true };
}

// ── Recently finished (a short log of completions, with durations) ──
const HIST_KEY = "history";
const HIST_MAX = 12;
const TOTALS_KEY = "totals"; // session: { [convId]: { totalMs, turns, seenAt } } — cumulative generation time per conversation (a job), not per tab
const TOTALS_MAX = 80;
async function pushHistory(entry) {
  const r = await chrome.storage.session.get(HIST_KEY);
  let arr = Array.isArray(r[HIST_KEY]) ? r[HIST_KEY] : [];
  if (typeof entry.tabId === "number") arr = arr.filter((h) => h.tabId !== entry.tabId); // one row per conversation
  arr.unshift({ ...entry, ts: Date.now() });
  await chrome.storage.session.set({ [HIST_KEY]: arr.slice(0, HIST_MAX) });
}
async function getHistory() {
  const r = await chrome.storage.session.get(HIST_KEY);
  return Array.isArray(r[HIST_KEY]) ? r[HIST_KEY] : [];
}

// Accumulate cumulative generation time per conversation (by convId, so it
// belongs to the job rather than the tab), then file the completion into the
// waiting queue (if away) and the recently-finished log.
async function recordCompletion(tabId, msg, windowId) {
  updateStats(msg.durationMs || 0, msg.site);
  const last = msg.durationMs || 0;
  const key = msg.convId || ("tab:" + tabId);
  const r = await chrome.storage.session.get(TOTALS_KEY);
  const totals = r[TOTALS_KEY] || {};
  const t = totals[key] || { totalMs: 0, turns: 0 };
  t.totalMs += last;
  t.turns += 1;
  t.seenAt = Date.now();
  totals[key] = t;
  // Keep the map bounded — drop the least-recently-touched conversations.
  const keys = Object.keys(totals);
  if (keys.length > TOTALS_MAX) {
    keys.sort((a, b) => (totals[a].seenAt || 0) - (totals[b].seenAt || 0));
    for (const k of keys.slice(0, keys.length - TOTALS_MAX)) delete totals[k];
  }
  await chrome.storage.session.set({ [TOTALS_KEY]: totals });

  const tag = { title: msg.title, site: msg.site, host: msg.host, url: msg.url, durationMs: last, totalMs: t.totalMs, turns: t.turns, prompt: (typeof msg.prompt === "string" ? msg.prompt.slice(0, 300) : null) };
  if (msg.hidden && msg.badge) await addWaiting(tabId, { ...tag, windowId });
  await pushHistory({ ...tag, tabId });
  await recordAnalytics({ ts: Date.now(), host: msg.host || "", site: msg.site || "", title: msg.title || "", durationMs: last, totalMs: t.totalMs, turns: t.turns, startMs: (typeof msg.startMs === "number" ? msg.startMs : null), prompt: (typeof msg.prompt === "string" ? msg.prompt.slice(0, 300) : null) });
}

// ── Analytics (local-only, survives updates; powers the panel summary + CSV export) ──
// Two stores in chrome.storage.local: lifetime per-host aggregates, plus a
// bounded rolling per-run log. Never leaves the device; the ZIP/update never
// touches storage, so history persists across upgrades.
const RUNLOG_MAX = 500;
async function recordAnalytics(run) {
  try {
    const r = await chrome.storage.local.get([SAN.KEYS.SITE_STATS, SAN.KEYS.RUN_LOG]);
    const key = run.host || run.site || "other";
    const agg = r[SAN.KEYS.SITE_STATS] || {};
    const a = agg[key] || { site: run.site || run.host || "", runs: 0, totalMs: 0, longestMs: 0, lastTs: 0 };
    a.site = run.site || a.site || run.host || "";
    a.runs += 1;
    a.totalMs += Math.max(0, run.durationMs || 0);
    if ((run.durationMs || 0) > a.longestMs) a.longestMs = run.durationMs || 0;
    if (typeof run.startMs === "number") { // time-to-start, only on network-hooked sites
      a.startRuns = (a.startRuns || 0) + 1;
      a.startTotalMs = (a.startTotalMs || 0) + Math.max(0, run.startMs);
    }
    a.lastTs = run.ts;
    agg[key] = a;

    const log = Array.isArray(r[SAN.KEYS.RUN_LOG]) ? r[SAN.KEYS.RUN_LOG] : [];
    log.unshift({ ts: run.ts, host: run.host, site: run.site, title: run.title, durationMs: run.durationMs || 0, totalMs: run.totalMs || 0, turns: run.turns || 1, startMs: (typeof run.startMs === "number" ? run.startMs : null), prompt: (run.prompt || null) });
    await chrome.storage.local.set({ [SAN.KEYS.SITE_STATS]: agg, [SAN.KEYS.RUN_LOG]: log.slice(0, RUNLOG_MAX) });
  } catch (e) {}
}

// ── Running map (live "what's generating right now") ──────────
async function getRunning() {
  const r = await chrome.storage.session.get(RUN_KEY);
  return r[RUN_KEY] || {};
}
async function setRunning(m) { await chrome.storage.session.set({ [RUN_KEY]: m }); }
async function addRunning(tabId, entry) {
  if (typeof tabId !== "number") return;
  const [run, wait] = await Promise.all([getRunning(), getWaiting()]);
  run[tabId] = { ...entry, ts: run[tabId]?.ts || Date.now(), seenAt: Date.now() }; // ts = start (for elapsed), seenAt = last heartbeat (for staleness)
  if (wait[tabId]) { delete wait[tabId]; await setWaiting(wait); await renderBadge(); } // can't be both
  await setRunning(run);
}
async function removeRunning(tabId) {
  const run = await getRunning();
  if (run[tabId]) { delete run[tabId]; await setRunning(run); }
}
// Validated, sorted snapshot of both lists (drops tabs that no longer exist).
async function listState() {
  const [run, wait] = await Promise.all([getRunning(), getWaiting()]);
  const now = Date.now();
  const ids = [...new Set([...Object.keys(run), ...Object.keys(wait)])];
  const alive = await Promise.allSettled(ids.map((id) => chrome.tabs.get(Number(id))));
  let changed = false;
  ids.forEach((id, i) => {
    if (alive[i].status === "rejected") {
      if (run[id]) { delete run[id]; changed = true; }
      if (wait[id]) { delete wait[id]; changed = true; }
    } else if (run[id] && now - (run[id].seenAt || run[id].ts) > STALE_RUN_MS) {
      delete run[id]; changed = true; // alive tab, but the content script stopped reporting — treat as no longer running
    }
  });
  if (changed) { await Promise.all([setRunning(run), setWaiting(wait)]); await renderBadge(); }
  const toArr = (o) => Object.entries(o).map(([tabId, v]) => ({ tabId: Number(tabId), ...v })).sort((a, b) => b.ts - a.ts);
  const hist = await getHistory();
  const history = hist.filter((h) => !run[String(h.tabId)] && !wait[String(h.tabId)]); // a tab is running, waiting, OR recently finished — never two at once
  const blocked = await listBlocked();
  return { running: toArr(run), waiting: toArr(wait), blocked, history, panelOpen: panelIsOpen() };
}

// ── User-added sites ──────────────────────────────────────────
// Sites the user chooses to watch beyond the built-ins. We register a content
// script for each granted origin; detection there uses the generic profile.
const USER_SITES_KEY = "userSites"; // local: [{ origin, host }]
function scriptIdFor(origin) { return "us-" + origin.replace(/[^a-z0-9]/gi, "_").slice(0, 60); }
async function getUserSites() {
  const r = await chrome.storage.local.get(USER_SITES_KEY);
  return Array.isArray(r[USER_SITES_KEY]) ? r[USER_SITES_KEY] : [];
}
async function registerUserSite(origin) {
  if (!(chrome.scripting && chrome.scripting.registerContentScripts)) return false;
  const id = scriptIdFor(origin);
  try { await chrome.scripting.unregisterContentScripts({ ids: [id] }); } catch (e) {}
  try {
    await chrome.scripting.registerContentScripts([{
      id, matches: [origin], js: ["constants.js", "profiles.js", "content.js"], runAt: "document_idle", persistAcrossSessions: true,
    }]);
    return true;
  } catch (e) { console.warn("[Sanity] register failed:", origin, e && e.message); return false; }
}
async function unregisterUserSite(origin) {
  try { await chrome.scripting.unregisterContentScripts({ ids: [scriptIdFor(origin)] }); } catch (e) {}
}
async function syncUserSites() {
  // Startup: re-register for stored sites whose permission is still granted.
  const sites = await getUserSites();
  for (const s of sites) {
    try { if (await chrome.permissions.contains({ origins: [s.origin] })) await registerUserSite(s.origin); } catch (e) {}
  }
}
syncUserSites();


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || msg.target === "offscreen") return;
  const tabId = sender && sender.tab && sender.tab.id;
  const windowId = sender && sender.tab && sender.tab.windowId;

  switch (msg.type) {
    case "done": {
      removeRunning(tabId);
      removeBlocked(tabId);
      if (typeof tabId === "number") {
        const now = Date.now();
        const prev = lastDone.get(tabId) || 0;
        lastDone.set(tabId, now);
        if (now - prev < DONE_DEBOUNCE_MS) return; // flapping / streamed-chunk gap — one completion, not many
      }
      if (msg.chime) playChime();
      if (msg.notif) {
        notifyDone(tabId, msg.title, msg.durationMs, msg.url);                                                              // OS banner via offscreen
        broadcastToast({ site: msg.site, host: msg.host, title: msg.title, durationMs: msg.durationMs, url: msg.url, jumpTabId: tabId }); // in-page toast (complementary)
      }
      recordCompletion(tabId, msg, windowId);
      return;
    }

    case "running":
      if (msg.on) { addRunning(tabId, { title: msg.title, site: msg.site, host: msg.host, url: msg.url, windowId, prompt: (typeof msg.prompt === "string" ? msg.prompt.slice(0, 300) : null) }); lastDone.delete(tabId); removeBlocked(tabId); }
      else removeRunning(tabId);
      return;

    case "blocked": {
      if (!msg.on) { removeBlocked(tabId); return; }
      (async () => {
        const isNew = await addBlocked(tabId, { title: msg.title, site: msg.site, host: msg.host, url: msg.url, windowId, prompt: (typeof msg.prompt === "string" ? msg.prompt.slice(0, 300) : null) });
        if (!isNew) return; // heartbeat refresh — don't re-alert
        if (msg.chime) playChime();
        if (msg.notif && msg.hidden && HAS_NOTIFICATIONS) {
          const name = (msg.title || "").trim() || "Your agent";
          try {
            const r = await chrome.storage.session.get(NOTIF_URLS_KEY);
            const map = r[NOTIF_URLS_KEY] || {};
            map[NOTIF_PREFIX + tabId] = msg.url || "";
            await chrome.storage.session.set({ [NOTIF_URLS_KEY]: map });
            chrome.notifications.create(NOTIF_PREFIX + tabId, {
              type: "basic", iconUrl: ICON, title: name,
              message: "Needs your input — click to jump back.", priority: 2,
            }, () => void chrome.runtime.lastError);
          } catch (e) {}
        }
        if (msg.hidden) broadcastToast({ site: msg.site, host: msg.host, title: msg.title, url: msg.url, jumpTabId: tabId, input: true });
      })();
      return;
    }

    case "seen":
      clearForTab(tabId);
      removeWaiting(tabId);
      return;

    case "hopeCmd":
      // Panel -> SW -> Hope tabs (targeted; session storage stays trusted-only).
      try {
        chrome.tabs.query({ url: "https://bit.cloud/hope/session/*" }, (tabs) => {
          for (const t of tabs || []) chrome.tabs.sendMessage(t.id, { type: "hopeCmd", action: msg.action }, () => void chrome.runtime.lastError);
        });
      } catch (e) {}
      return;

    case "hopeReading":
      // Collapse script -> SW -> stored for the (trusted) panel to read.
      try { chrome.storage.session.set({ hopeReading: { ...(msg.data || {}), ts: Date.now() } }); } catch (e) {}
      return;

    case "testChime":
      playChime();
      return;

    case "getState":
      listState().then(sendResponse);
      return true;

    case "panelPing":
      lastPanelPing = Date.now();
      try { chrome.storage.session.set({ panelOpen: true }); } catch (e) {}
      return;

    case "dismiss":
      clearForTab(msg.tabId);
      Promise.all([removeWaiting(msg.tabId), removeRunning(msg.tabId), removeBlocked(msg.tabId)]).then(listState).then(sendResponse);
      return true;

    case "focusTab":
      focusTab(msg.tabId, msg.url).then(sendResponse);
      return true;

    case "clearHistory":
      chrome.storage.session.set({ [HIST_KEY]: [] }).then(listState).then(sendResponse);
      return true;

    case "clearHistoryItem":
      getHistory().then((arr) => {
        const next = arr.filter((h) => !(
          (typeof msg.ts === "number" && h.ts === msg.ts) ||
          (typeof msg.tabId === "number" && h.tabId === msg.tabId && (typeof msg.ts !== "number" || h.ts === msg.ts))
        ));
        return chrome.storage.session.set({ [HIST_KEY]: next });
      }).then(listState).then(sendResponse);
      return true;

    case "listUserSites":
      getUserSites().then((sites) => sendResponse({ sites }));
      return true;

    case "addUserSite": {
      (async () => {
        const origin = msg.origin, host = msg.host || origin;
        const sites = await getUserSites();
        if (!sites.some((s) => s.origin === origin)) {
          sites.push({ origin, host });
          await chrome.storage.local.set({ [USER_SITES_KEY]: sites });
        }
        await registerUserSite(origin);
        // Inject into already-open tabs of that site so it works without a reload.
        try {
          const tabs = await chrome.tabs.query({ url: origin });
          for (const t of tabs) { try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ["constants.js", "profiles.js", "content.js"] }); } catch (e) {} }
        } catch (e) {}
        sendResponse({ ok: true, sites });
      })();
      return true;
    }

    case "removeUserSite": {
      (async () => {
        const origin = msg.origin;
        const sites = (await getUserSites()).filter((s) => s.origin !== origin);
        await chrome.storage.local.set({ [USER_SITES_KEY]: sites });
        await unregisterUserSite(origin);
        try { await chrome.permissions.remove({ origins: [origin] }); } catch (e) {}
        sendResponse({ ok: true, sites });
      })();
      return true;
    }
  }
});

// ── Notification clicks ───────────────────────────────────────
// Native banners route here; the offscreen fallback routes via its own onclick.
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener(async (notifId) => {
    if (typeof notifId !== "string" || !notifId.startsWith(NOTIF_PREFIX)) return;
    const tabId = Number(notifId.slice(NOTIF_PREFIX.length));
    let url = "";
    try { const r = await chrome.storage.session.get(NOTIF_URLS_KEY); url = (r[NOTIF_URLS_KEY] || {})[notifId] || ""; } catch (e) {}
    if (Number.isFinite(tabId)) focusTab(tabId, url);
    try { chrome.notifications.clear(notifId); } catch (e) {}
    // A click means "I've got it" → clear the waiting queue + badge for that tab.
    await Promise.all([removeWaiting(tabId), removeRunning(tabId), removeBlocked(tabId)]);
    clearForTab(tabId);
    renderBadge();
  });
}

// ── Housekeeping ──────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  clearForTab(tabId);
  removeWaiting(tabId);
  removeRunning(tabId);
  removeBlocked(tabId);
});
// React to the marker toggle being flipped while items are queued.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.badge) renderBadge();
});
chrome.runtime.onStartup?.addListener(renderBadge);
renderBadge(); // also runs whenever the SW spins back up

// ── Side panel ("control tower") ──────────────────────────────
// Chrome/Brave/Dia use the docked side panel. Browsers without a working
// sidePanel API (e.g. Arc) fall back to a popup showing the same UI, so the
// toolbar icon always does something. Existing side-panel browsers are untouched.
const HAS_SIDE_PANEL = !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior && chrome.sidePanel.open && chrome.sidePanel.setOptions);
// ── Surface selection: popup by default, side panel by proof ──
// Arc inherits the chrome.sidePanel API from Chromium but its methods no-op,
// so "the object exists" proves nothing. Three layers:
//   1. manifest default_popup — a click always opens SOMETHING, in any browser.
//   2. Opt-in: only if setPanelBehavior + setOptions actually resolve do we
//      remove the popup and let clicks open the side panel (Chrome/Dia/Brave).
//   3. Self-heal: if action.onClicked ever fires while we think the panel owns
//      the click, the panel behavior silently no-oped (the Arc trap) — flip to
//      popup mode permanently (persisted) and open it within this same gesture.
let panelOn = false;           // default OFF — popup works everywhere; panel must prove itself
let lastPanelPing = 0;         // ms of last sign of life from the open panel
const PANEL_FRESH_MS = 9000;   // panel considered open if pinged within this window
function panelIsOpen() { return Date.now() - lastPanelPing < PANEL_FRESH_MS; }
let focusedWindowId = chrome.windows.WINDOW_ID_NONE;

function enablePopupFallback() {
  panelOn = false;
  try { chrome.action.setPopup({ popup: "popup.html" }); } catch (e) {}
}

async function syncPanelSetting() {
  try {
    const r = await chrome.storage.local.get("forcePopup");
    if (r.forcePopup) { enablePopupFallback(); return; } // healed on this browser before — stay in popup mode
  } catch (e) {}
  if (!HAS_SIDE_PANEL) { enablePopupFallback(); return; }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    await chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true });
    panelOn = true;
    try { chrome.action.setPopup({ popup: "" }); } catch (e) {} // hand the click to the panel
  } catch (e) {
    enablePopupFallback();
  }
}
syncPanelSetting();

// Layer 3: this listener is silent in browsers where the click is consumed by
// the popup or the (working) panel behavior. If it fires in panel mode, the
// behavior was a silent no-op — heal to popup, inside the user's gesture.
chrome.action.onClicked.addListener(() => {
  if (!panelOn) return;
  enablePopupFallback();
  try { chrome.storage.local.set({ forcePopup: true }); } catch (e) {}
  try { chrome.action.openPopup(); } catch (e) {} // best effort now; next click opens it regardless
});

// Track the focused window so the toggle can open the panel synchronously
// within the keyboard gesture (no await before open()).
chrome.windows.onFocusChanged.addListener((id) => {
  if (id !== chrome.windows.WINDOW_ID_NONE) focusedWindowId = id;
});
chrome.windows.getLastFocused().then((w) => { if (w) focusedWindowId = w.id; }).catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sanity-panel") return;
  lastPanelPing = Date.now();
  try { chrome.storage.session.set({ panelOpen: true }); } catch (e) {}
  port.onDisconnect.addListener(() => { lastPanelPing = 0; try { chrome.storage.session.set({ panelOpen: false }); } catch (e) {} });
});

chrome.commands.onCommand.addListener((cmd) => {
  if (cmd !== "toggle_panel") return;
  if (!panelOn) { try { chrome.action.openPopup(); } catch (e) {} return; } // popup-mode browsers (Arc): open the popup instead
  if (panelIsOpen()) {
    // No official close() exists — disable then re-enable closes the panel
    // while keeping it available for next time.
    chrome.sidePanel.setOptions({ enabled: false })
      .then(() => chrome.sidePanel.setOptions({ path: "sidepanel.html", enabled: true }))
      .catch(() => {});
    lastPanelPing = 0;
  } else if (focusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
    chrome.sidePanel.open({ windowId: focusedWindowId }).catch(() => {});
  } else {
    chrome.windows.getLastFocused().then((w) => chrome.sidePanel.open({ windowId: w.id })).catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.panel) syncPanelSetting();
});

// Fresh install: make the side panel explicitly ON by default.
// Re-inject content scripts into tabs that are already open. An extension
// update orphans the old scripts (dead chrome.runtime) and Chrome won't inject
// the new ones until the tab reloads — so a running session silently stops
// being watched. Guards inside each file make a double injection a no-op.
const MONITOR_FILES = ["constants.js", "profiles.js", "content.js"];
const MONITOR_MATCHES = ["https://bit.cloud/*", "https://claude.ai/*", "https://gemini.google.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*", "https://cursor.com/*", "https://www.cursor.com/*"];
const NET_MATCHES = ["https://bit.cloud/*", "https://claude.ai/*", "https://gemini.google.com/*", "https://chatgpt.com/*", "https://chat.openai.com/*"];
async function injectIntoOpenTabs() {
  if (!(chrome.scripting && chrome.scripting.executeScript)) return;
  const query = async (url) => { try { return await chrome.tabs.query({ url }); } catch (e) { return []; } };
  const inject = async (tabId, files, world) => {
    try { await chrome.scripting.executeScript({ target: { tabId }, files, ...(world ? { world } : {}) }); } catch (e) {}
  };
  for (const t of await query(MONITOR_MATCHES)) await inject(t.id, MONITOR_FILES);
  for (const t of await query(["https://bit.cloud/*"])) await inject(t.id, ["constants.js", "collapse.js"]);
  for (const t of await query(NET_MATCHES)) await inject(t.id, ["nethook.js"], "MAIN");
  try {
    for (const s of await getUserSites()) {
      for (const t of await query([s.origin])) await inject(t.id, MONITOR_FILES);
    }
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install" || details.reason === "update") injectIntoOpenTabs();
  if (details.reason !== "install") return;
  try {
    const r = await chrome.storage.local.get("panel");
    if (r.panel === undefined) await chrome.storage.local.set({ panel: true });
  } catch (e) {}
  syncPanelSetting();
  // A single, quiet welcome page — test the chime, see what's watched.
  try { chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") }); } catch (e) {}
});

// ── Local usage stats (never leaves the device) ───────────────
// Powers the "This week" line in the panel: runs, agent time, longest run.
async function updateStats(durationMs, site) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const r = await chrome.storage.local.get(SAN.KEYS.STATS);
    const stats = r[SAN.KEYS.STATS] || { days: {}, longest: null };
    const d = stats.days[day] || { runs: 0, ms: 0 };
    d.runs += 1; d.ms += Math.max(0, durationMs || 0);
    stats.days[day] = d;
    if (!stats.longest || (durationMs || 0) > stats.longest.ms) {
      stats.longest = { ms: durationMs || 0, site: site || "", ts: Date.now() };
    }
    // Keep only the last 14 days.
    const cutoff = Date.now() - 14 * 86400000;
    for (const k of Object.keys(stats.days)) {
      if (new Date(k + "T00:00:00Z").getTime() < cutoff) delete stats.days[k];
    }
    await chrome.storage.local.set({ [SAN.KEYS.STATS]: stats });
  } catch (e) {}
}
