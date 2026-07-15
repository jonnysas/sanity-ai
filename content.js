(() => {
  "use strict";

  // Injected twice (manifest + the on-update re-inject in the SW)? No-op.
  if (window.__sanityMonitorLoaded) return;
  window.__sanityMonitorLoaded = true;

  // ════════════════════════════════════════════════════════════
  //  Sanity — content script
  //  Detects when an AI agent is working and signals "done" once it
  //  goes quiet. Detection is profile-driven: one engine, many sites.
  //  Each profile can be turned off in the popup (key: sites[name]).
  // ════════════════════════════════════════════════════════════

  // ── Tunables ────────────────────────────────────────────────
  // Settle/min-active are per-profile (chat UIs react fast; agentic tools
  // pause between steps and need a longer quiet window). Defaults below.
  const DEFAULT_SETTLE_MS = 10000;     // quiet period after work stops -> notify
  const DEFAULT_MIN_ACTIVE_MS = 5000;  // ignore work bursts shorter than this
  const SAFETY_POLL_MS = 3000;         // backstop re-check (observer is primary)
  const OBSERVER_DEBOUNCE_MS = 250;

  // ── Detection data (profiles.js, loaded before this file) ──
  const DETECT = window.SANITY_DETECT || { STOP_CONTROLS: [], SPINNERS: [], PROFILES: [], APPROVE_RE: /$^/, REJECT_RE: /$^/, APPROVAL_TESTIDS: "" };
  const PROFILES = DETECT.PROFILES;

  // The profile is re-picked on SPA route changes: on bit.cloud the same tab
  // moves between a muted profile (site pages) and "hope" (session pages).
  function pickProfile() {
    return PROFILES.find((p) => p.test(location.host, location.pathname))
      || PROFILES[PROFILES.length - 1];
  }
  let profile = pickProfile();
  let SETTLE_MS = profile.settleMs ?? DEFAULT_SETTLE_MS;
  let MIN_ACTIVE_MS = profile.minActiveMs ?? DEFAULT_MIN_ACTIVE_MS;

  // ── Preferences ─────────────────────────────────────────────
  const NOTIFY_KEYS = ["chime", "notif", "badge"];
  const SITES_KEY = "sites";
  const prefs = { chime: true, notif: true, badge: true };
  let siteEnabled = {}; // name -> bool (missing = on)

  function isEnabled() { return !profile.disabled && siteEnabled[profile.settings || profile.name] !== false; }

  if (chrome?.storage?.local) {
    chrome.storage.local.get([...NOTIFY_KEYS, SITES_KEY], (res) => {
      if (chrome.runtime.lastError) return;
      for (const k of NOTIFY_KEYS) if (res[k] !== undefined) prefs[k] = res[k];
      if (res[SITES_KEY] && typeof res[SITES_KEY] === "object") siteEnabled = res[SITES_KEY];
    });
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === "local") {
        for (const [k, { newValue }] of Object.entries(changes)) {
          if (NOTIFY_KEYS.includes(k) && newValue !== undefined) prefs[k] = newValue;
          if (k === SITES_KEY) siteEnabled = (newValue && typeof newValue === "object") ? newValue : {};
        }
      }
    });
  }

  // Completion toast: the SW sends it to the active tab only (targeted message —
  // session storage stays trusted-only, nothing broadcast to page contexts).
  // settleCheck: the SW's callback for the settle window (see startSettling) —
  // hidden tabs get their timers throttled to a crawl, so the SW keeps time.
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === "sanityToast" && !document.hidden) showToast(msg);
      if (msg.type === "settleCheck" && state === "SETTLING") {
        clearTimeout(settleTimer);
        finish();
      }
      // Live detection snapshot for the debug report: which signals think the
      // agent is working right now — pinpoints stuck runs from a paste.
      if (msg.type === "detectReport") {
        try { sendResponse(detectSnapshot()); } catch (e) { sendResponse({ err: e && e.message }); }
      }
    });
  } catch (e) {}

  // What does detection see, right now? (consumed by "Copy debug report")
  function detectSnapshot() {
    const domHits = [];
    try {
      const root = profile.root() || document.body;
      if (root) {
        for (const sel of profile.indicatorSelectors) {
          let els; try { els = root.querySelectorAll(sel); } catch (e) { continue; }
          for (const el of els) { if (isVisible(el)) { domHits.push(sel); break; } }
        }
      }
    } catch (e) {}
    let score = -1; try { score = indicatorScore(); } catch (e) {}
    let approval = false; try { approval = approvalVisible(); } catch (e) {}
    return {
      profile: profile.name,
      state,
      netActive,
      useNetwork: !!profile.useNetwork,
      domFallback: !!profile.domFallback,
      score,
      domHits: domHits.slice(0, 8),
      approval,
      workStartedAt,
      workStoppedAt,
      hidden: document.hidden,
      href: location.href.slice(0, 140),
    };
  }

  // ── In-page toast (primary notifier — bypasses the OS entirely) ──
  let toastHost = null, toastTimer = null;
  function dismissToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (toastHost) { try { toastHost.remove(); } catch (e) {} toastHost = null; }
  }
  function toastTool(site, host) {
    const s = (site || "").toLowerCase(), h = (host || "").toLowerCase();
    if (h.includes("bit.cloud") || s.includes("hope")) return { grad: true, glyph: "H" };
    if (s.includes("claude") || h.includes("claude")) return { color: "#d97757", glyph: "C" };
    if (s.includes("gemini") || h.includes("gemini")) return { color: "#4285f4", glyph: "\u2726" };
    if (s.includes("chatgpt") || h.includes("openai") || h.includes("chatgpt")) return { color: "#10a37f", glyph: "G" };
    if (s.includes("cursor") || h.includes("cursor")) return { color: "#6b7280", glyph: "\u203A" };
    return { color: "#6366f1", glyph: "\u2022" };
  }
  function durText(ms) {
    const s = Math.round((ms || 0) / 1000);
    if (!s) return "";
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60), r = s % 60;
    if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? `${h}h ${rm}m` : `${h}h`;
  }
  function showToast(t) {
    dismissToast();
    const tool = toastTool(t.site, t.host);
    // Still Water: the toast follows the OS theme into the dark, and moves
    // at settle pace (or not at all, under reduced motion).
    const dark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    const still = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const th = dark
      ? { bg: "#211F27", line: "#34323C", t1: "#EDECEF", t2: "#9C99A6", chk: "#30d158", x: "#8A8794", xh: "#33313C", xhc: "#D2D0D8", shadow: "0 0 0 1px rgba(255,255,255,0.04), 0 14px 40px rgba(0,0,0,0.5)" }
      : { bg: "#FDFCFA", line: "#ECEAE6", t1: "#1C1B22", t2: "#6E6B78", chk: "#34c759", x: "#B3B0BC", xh: "#F2F0EC", xhc: "#4A4852", shadow: "0 2px 6px rgba(28,27,34,0.06), 0 14px 36px rgba(40,40,70,0.18)" };
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;bottom:20px;right:20px;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      ".card{display:flex;align-items:center;gap:12px;width:300px;max-width:78vw;padding:13px 14px;" +
      "background:" + th.bg + ";border:1px solid " + th.line + ";border-radius:14px;box-shadow:" + th.shadow + ";" +
      "cursor:pointer;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;" +
      "font-variant-numeric:tabular-nums;" +
      (still
        ? "opacity:0;transition:opacity .12s linear;"
        : "transform:translateX(16px);opacity:0;transition:transform .26s cubic-bezier(.16,1,.3,1),opacity .26s cubic-bezier(.16,1,.3,1);") +
      "}" +
      ".card.in{transform:none;opacity:1;}" +
      ".av{position:relative;width:34px;height:34px;border-radius:50%;flex:0 0 auto;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:15px;}" +
      ".chk{position:absolute;right:-3px;bottom:-3px;width:16px;height:16px;border-radius:50%;background:" + th.chk + ";border:2px solid " + th.bg + ";display:flex;align-items:center;justify-content:center;}" +
      ".chk svg{width:8px;height:8px;}" +
      ".tx{min-width:0;flex:1;}" +
      ".t1{font-size:13.5px;font-weight:650;letter-spacing:-0.006em;color:" + th.t1 + ";white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      ".t2{font-size:11.5px;color:" + th.t2 + ";margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      ".x{flex:0 0 auto;border:none;background:none;color:" + th.x + ";font-size:14px;line-height:1;cursor:pointer;padding:4px;border-radius:6px;}" +
      ".x:hover{background:" + th.xh + ";color:" + th.xhc + ";}";
    const card = document.createElement("div"); card.className = "card";
    card.setAttribute("role", "status"); // polite live region — screen readers hear the completion
    const av = document.createElement("div"); av.className = "av";
    av.style.background = tool.grad ? "linear-gradient(135deg,#6d5efc,#c43cdb)" : tool.color;
    av.textContent = tool.glyph;
    // Badge tells the truth: green check = done; amber ? = paused on you.
    const chk = document.createElement("div"); chk.className = "chk";
    if (t.input) {
      chk.style.background = dark ? "#E9A02C" : "#F59E0B";
      chk.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M9.2 9a3 3 0 1 1 4.3 2.7c-.9.5-1.5 1-1.5 2.1M12 17.2h.01" stroke="#3D2A05" stroke-width="2.6" stroke-linecap="round"/></svg>';
    } else {
      chk.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
    av.appendChild(chk);
    const tx = document.createElement("div"); tx.className = "tx";
    const t1 = document.createElement("div"); t1.className = "t1";
    t1.textContent = t.title || ((t.site || "Agent") + (t.input ? " needs you" : " finished"));
    const t2 = document.createElement("div"); t2.className = "t2";
    const d = durText(t.durationMs);
    t2.textContent = t.input
      ? (t.site ? t.site : "") + " \u00b7 waiting on your approval"
      : (t.site ? t.site : "") + (d ? " \u00b7 took " + d : "") + " \u00b7 ready when you are";
    tx.append(t1, t2);
    const x = document.createElement("button"); x.className = "x"; x.textContent = "\u2715"; x.setAttribute("aria-label", "Dismiss");
    x.addEventListener("click", (e) => { e.stopPropagation(); dismissToast(); });
    card.append(av, tx, x);
    card.addEventListener("click", () => { send({ type: "focusTab", tabId: t.jumpTabId, url: t.url }); dismissToast(); });
    // Hovering pauses the clock — the toast waits while you read.
    card.addEventListener("mouseenter", () => { if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; } });
    card.addEventListener("mouseleave", () => { if (toastHost === host && !toastTimer) toastTimer = setTimeout(dismissToast, 4000); });
    root.append(style, card);
    (document.body || document.documentElement).appendChild(host);
    toastHost = host;
    requestAnimationFrame(() => card.classList.add("in"));
    toastTimer = setTimeout(dismissToast, 9000);
  }

  // ── Element visibility (handles position:fixed, unlike offsetParent) ──
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  }

  // ── "Is the agent working right now?" ───────────────────────
  // Signal scan. Built-in profiles keep the original OR semantics (any visible
  // indicator = working). The generic profile (user-added sites) is *scored*:
  // a bare page spinner (weight 1) isn't enough on its own — it needs a stop
  // control (3), an agent text signal (2), or a second cue to corroborate.
  function indicatorScore() {
    const root = profile.root() || document.body;
    if (!root) return 0;
    const stopSet = DETECT.STOP_CONTROLS;
    let score = 0;

    for (const sel of profile.indicatorSelectors) {
      let els;
      try { els = root.querySelectorAll(sel); } catch { continue; }
      for (const el of els) {
        if (!isVisible(el)) continue;
        score += stopSet.includes(sel) ? 3 : 1;
        break; // one hit per selector is enough
      }
      if (score >= 3) return score;
    }

    if (profile.textSignals.length) {
      const probe = document.elementsFromPoint(window.innerWidth / 2, window.innerHeight - 120);
      for (const el of probe) {
        const txt = el.textContent || "";
        if (txt.length > 200) continue;
        if (profile.textSignals.some((re) => re.test(txt))) { score += 2; break; }
      }
    }

    if (score < 3 && profile.actionInProgress) {
      const c = root.querySelectorAll('[class*="action" i], [class*="step" i], [class*="tool" i]');
      for (let i = c.length - 1, seen = 0; i >= 0 && seen < 40; i--, seen++) {
        const el = c[i];
        if (!isVisible(el)) continue;
        const txt = (el.textContent || "").trim();
        if (txt.length > 10 && txt.length < 100 && profile.actionInProgress(txt)) { score += 3; break; }
      }
    }
    return score;
  }
  function hasActiveIndicators() {
    return indicatorScore() >= (profile.scored ? 2 : 1);
  }

  // ── Network signal (MAIN-world hook via postMessage) ────────
  // For profiles where the DOM is unreliable in the background, the hook tells
  // us when the agent's request is in flight. This works even while hidden.
  let netActive = false;
  let netStartMs = null;   // prompt-submit -> first streamed byte (from nethook)
  let netPrompt = null;    // the user's prompt text (from nethook; local-only)
  {
    // Registered unconditionally: on bit.cloud the tab can start on a muted
    // profile and only repick to a network-enabled one after SPA navigation.
    window.addEventListener("message", (e) => {
      if (e.source !== window || !e.data || !e.data.__sanity) return;
      if (e.data.type === "net-start") {
        if (typeof e.data.latencyMs === "number") netStartMs = e.data.latencyMs;
        return;
      }
      if (e.data.type === "net-prompt") {
        if (typeof e.data.text === "string" && e.data.text) netPrompt = e.data.text.slice(0, 300);
        return;
      }
      if (e.data.type !== "net") return;
      const was = netActive;
      netActive = !!e.data.active;
      if (netActive !== was) evaluate();
    });
    // Ask the hook for its current state in case a request was already running.
    try { window.postMessage({ __sanity: true, type: "net-query" }, location.origin); } catch {}
  }

  function isWorking() {
    if (profile.useNetwork) {
      return profile.domFallback ? (netActive || hasActiveIndicators()) : netActive;
    }
    return hasActiveIndicators();
  }

  // ── "Needs your input" — an agent paused mid-run for approval ─
  // A visible approve-ish button, corroborated by a reject-ish sibling or an
  // explicit approval test id (a lone "Run"/"Continue" button doesn't count).
  function approvalVisible() {
    const root = profile.root() || document.body;
    if (!root) return false;
    try {
      if (DETECT.APPROVAL_TESTIDS) {
        const ids = root.querySelectorAll(DETECT.APPROVAL_TESTIDS);
        for (const el of ids) if (isVisible(el)) return true;
      }
      const btns = root.querySelectorAll('button, [role="button"]');
      let approve = false, reject = false;
      let seen = 0;
      for (let i = btns.length - 1; i >= 0 && seen < 120; i--, seen++) {
        const el = btns[i];
        const txt = (el.textContent || el.getAttribute("aria-label") || "").trim();
        if (!txt || txt.length > 40 || !isVisible(el)) continue;
        if (!approve && DETECT.APPROVE_RE.test(txt)) approve = true;
        else if (!reject && DETECT.REJECT_RE.test(txt)) reject = true;
        if (approve && reject) return true;
      }
    } catch (e) {}
    return false;
  }

  // ── On-the-tab "done" marker ────────────────────────────────
  // The chime and notification are fired by the service worker (they must
  // work while this tab is in the background). The only signal a content
  // script alone can show on the tab itself is the title — so we prefix it
  // with a ✅ and keep re-applying it whenever the app rewrites its own
  // title, then strip it cleanly the moment the user returns.
  const MARK = "\u2705 ";       // ✅ done
  const MARK_INPUT = "\u2753 "; // ❓ needs your input
  let markWanted = false;
  let markGlyph = MARK;
  let titleObserver = null;

  function applyMark() {
    if (!document.title.startsWith(markGlyph)) document.title = markGlyph + document.title.replace(MARK, "").replace(MARK_INPUT, "");
  }
  function removeMark() {
    document.title = document.title.replace(MARK, "").replace(MARK_INPUT, "");
  }
  function startMark(glyph) {
    if (markWanted && markGlyph === (glyph || MARK)) return;
    markGlyph = glyph || MARK;
    markWanted = true;
    applyMark();
    if (!titleObserver) {
      const titleEl = document.querySelector("title");
      if (titleEl) {
        titleObserver = new MutationObserver(() => { if (markWanted) applyMark(); });
        titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
      }
    }
  }
  function stopMark() {
    if (!markWanted) return;
    markWanted = false;
    titleObserver?.disconnect();
    titleObserver = null;
    removeMark();
  }

  // ── Service worker (chime + notifications) ──────────────────
  function send(msg) {
    // After an extension reload, content scripts already running in open tabs
    // are orphaned: DOM still works (so ✅ appears) but messaging is severed.
    // chrome.runtime.id goes undefined in that state.
    if (!chrome.runtime?.id) {
      console.warn("[Sanity] extension was reloaded — refresh this tab to restore chime & notifications");
      return;
    }
    try { chrome.runtime.sendMessage(msg); }
    catch (e) { console.warn("[Sanity] couldn't reach background (refresh the tab):", e && e.message); }
  }
  function cleanTitle() {
    return (document.title || "").replace(MARK, "").replace(MARK_INPUT, "").replace(/^Hope AI \|\s*/, "").trim();
  }
  function reportRunning(on) {
    if (on) lastRunPing = Date.now();
    // The captured prompt rides along so the fleet can name the session by
    // its task ("Add CSV export…") when the tab title is generic.
    send({ type: "running", on, title: cleanTitle(), site: profile.label, host: location.host, url: location.href, prompt: netPrompt || undefined });
  }
  function reportBlocked(on) {
    if (on) lastRunPing = Date.now();
    send({
      type: "blocked", on,
      chime: prefs.chime, notif: prefs.notif, badge: prefs.badge, hidden: document.hidden,
      title: cleanTitle(), site: profile.label, host: location.host, url: location.href,
      prompt: netPrompt || undefined,
      convId: location.host + location.pathname,
    });
  }

  // ── State machine: IDLE -> WORKING -> SETTLING -> (done) -> IDLE ─
  const DEBUG = false; // set true to log the detection timeline
  function dbg(...a) {
    if (DEBUG) console.log("[Sanity]", new Date().toLocaleTimeString(), `hidden=${document.hidden}`, ...a);
  }

  let state = "IDLE";
  let workStartedAt = 0;
  let workStoppedAt = 0;
  let settleTimer = null;
  let lastRunPing = 0;                 // last time we told the SW "still running"
  const HEARTBEAT_MS = 25000;          // re-affirm a live run so it isn't dropped as stale

  function toIdle() {
    clearTimeout(settleTimer);
    settleTimer = null;
    state = "IDLE";
  }

  function enterWorking() {
    if (state === "WORKING") return;
    if (state !== "SETTLING") workStartedAt = Date.now();
    clearTimeout(settleTimer);
    settleTimer = null;
    state = "WORKING";
    reportRunning(true);
    dbg("→ WORKING (indicators detected)");
  }

  function startSettling() {
    if (state !== "WORKING") return;
    state = "SETTLING";
    workStoppedAt = Date.now();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(finish, SETTLE_MS);
    // Hidden tabs get their timers throttled to ≥1/min (Chrome; Dia is harsher),
    // which used to delay the "done" until the user came back to the tab — the
    // exact moment a notification is useless. The service worker's clock is
    // never tab-throttled, so ask it to call back when the window elapses.
    if (document.hidden) send({ type: "settlePing", ms: SETTLE_MS + 250 });
    dbg(`→ SETTLING (quiet; will confirm in ${SETTLE_MS}ms)`);
  }

  function finish() {
    settleTimer = null;
    if (isWorking()) { state = "WORKING"; dbg("settle aborted — still working (handoff)"); return; }

    const activeMs = workStoppedAt - workStartedAt;
    state = "IDLE";
    reportRunning(false);
    const startMs = typeof netStartMs === "number" ? netStartMs : null; // capture per-run, then reset
    const promptText = typeof netPrompt === "string" ? netPrompt : null;
    netStartMs = null; netPrompt = null; // one run's data only — never leak into the next (incl. too-short blips)
    if (activeMs < MIN_ACTIVE_MS) { dbg(`ignored — too short (${activeMs}ms < ${MIN_ACTIVE_MS}ms)`); return; }

    // Mark the tab only when the user is elsewhere — if they're here, the
    // chime already told them and there's nothing to "come back" to.
    const away = document.hidden;
    dbg(`✓ DONE (worked ${activeMs}ms, away=${away}) → firing`);
    if (prefs.badge && away) startMark();

    // Fire chime/notification (always useful) and let the SW queue this tab if
    // it finished while the user was away. All routed through the SW so they
    // work regardless of this tab being backgrounded.
    if (prefs.chime || prefs.notif || prefs.badge) {
      send({
        type: "done",
        chime: prefs.chime,
        notif: prefs.notif,
        badge: prefs.badge,
        hidden: away,
        durationMs: Math.max(0, activeMs),
        startMs, // time-to-start (fetch-hooked sites)
        prompt: promptText, // the user's prompt (local run log / CSV only)
        convId: location.host + location.pathname, // identifies the conversation, not the tab
        url: location.href, // so a closed tab can be reopened from the log
        title: cleanTitle(),
        site: profile.label,
        host: location.host,
      });
    }
  }

  function enterBlocked() {
    // Mid-run pause: the agent is waiting for the user's approval.
    clearTimeout(settleTimer); settleTimer = null;
    state = "BLOCKED";
    if (prefs.badge && document.hidden) startMark(MARK_INPUT);
    reportBlocked(true);
    dbg("→ BLOCKED (approval visible)");
  }
  function exitBlocked() {
    if (markGlyph === MARK_INPUT) stopMark();
    reportBlocked(false);
  }

  function evaluate() {
    if (!isEnabled()) { if (state !== "IDLE") { toIdle(); reportRunning(false); if (state === "BLOCKED") reportBlocked(false); } return; }
    const working = isWorking();
    switch (state) {
      case "IDLE":     if (working) enterWorking(); break;
      case "WORKING":
        if (!working) { if (approvalVisible()) enterBlocked(); else startSettling(); }
        break;
      case "SETTLING":
        if (working) { clearTimeout(settleTimer); settleTimer = null; state = "WORKING"; }
        else if (approvalVisible()) enterBlocked();
        break;
      case "BLOCKED":
        if (working) { exitBlocked(); state = "WORKING"; reportRunning(true); dbg("→ WORKING (approval handled, agent resumed)"); }
        else if (!approvalVisible()) { exitBlocked(); state = "WORKING"; startSettling(); dbg("approval gone → settling"); }
        break;
    }
  }

  // ── Triggers: an adaptive observer + SPA-navigation reset + a backstop. ──
  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(evaluate, OBSERVER_DEBOUNCE_MS);
  });
  // Observe the profile's container when it exists (low mutation volume on heavy
  // pages), falling back to <body> until it appears and re-attaching if the SPA
  // swaps it out. The old code attached once to a guessed root, so a missing or
  // remounted root meant you had to refresh; this stays efficient AND robust.
  let observedRoot = null;
  function ensureObserver() {
    const target = profile.root() || document.body || document.documentElement;
    if (target && target !== observedRoot) {
      try { observer.disconnect(); } catch {}
      try { observer.observe(target, { childList: true, subtree: true, characterData: true }); observedRoot = target; } catch {}
    }
  }
  ensureObserver();

  // SPA navigation: a new conversation must be caught without a refresh.
  let lastPath = location.pathname;
  let lastHref = location.href;
  function onNavigate() {
    if (location.href === lastHref) return;
    const pathChanged = location.pathname !== lastPath;
    lastHref = location.href; lastPath = location.pathname;
    if (pathChanged) {
      clearTimeout(settleTimer); settleTimer = null;
      if (state === "BLOCKED") exitBlocked();
      state = "IDLE"; stopMark();
      // The route change may have crossed a profile boundary (bit.cloud pages ↔
      // hope session) — re-pick and re-attach the observer to the new root.
      profile = pickProfile();
      SETTLE_MS = profile.settleMs ?? DEFAULT_SETTLE_MS;
      MIN_ACTIVE_MS = profile.minActiveMs ?? DEFAULT_MIN_ACTIVE_MS;
      observedRoot = null;
      evaluate(); // a run may already be in flight (widget prompt → session nav)
    }
    ensureObserver();
    setTimeout(() => { ensureObserver(); evaluate(); }, 300);
    setTimeout(() => { ensureObserver(); evaluate(); }, 900);
  }
  if (window.navigation && window.navigation.addEventListener) {
    try { window.navigation.addEventListener("navigate", () => setTimeout(onNavigate, 0)); } catch {}
  }
  window.addEventListener("popstate", () => setTimeout(onNavigate, 0));

  setInterval(() => {
    if (markWanted) applyMark();
    if (location.href !== lastHref) onNavigate();
    ensureObserver();          // narrow once the root appears / re-attach on remount
    // Idle + backgrounded: skip the DOM re-check to save CPU. The observer still
    // wakes us on real changes; the heartbeat only matters while working.
    if (!(document.hidden && state === "IDLE")) evaluate();
    if ((state === "WORKING" || state === "SETTLING") && Date.now() - lastRunPing > HEARTBEAT_MS) reportRunning(true);
    if (state === "BLOCKED" && Date.now() - lastRunPing > HEARTBEAT_MS) reportBlocked(true);
  }, SAFETY_POLL_MS);

  // Catch work already in progress when we load (the "had to refresh" case).
  setTimeout(() => { ensureObserver(); evaluate(); }, 300);
  setTimeout(() => { ensureObserver(); evaluate(); }, 1200);
  setTimeout(() => { ensureObserver(); evaluate(); }, 2500);

  // ── Clear the tab marker AND notification once the user is here ──
  document.addEventListener("visibilitychange", () => {
    dismissToast(); // returning to or leaving a tab clears any toast showing on it
    if (!document.hidden) {
      // Belt and braces for throttled timers: if the settle window already
      // elapsed while this tab was hidden (and the SW callback got lost to a
      // worker restart), conclude the run right now.
      if (state === "SETTLING" && Date.now() - workStoppedAt >= SETTLE_MS && !isWorking()) {
        clearTimeout(settleTimer);
        finish();
      }
      stopMark();
      send({ type: "seen" }); // tell the SW to dismiss this tab's notification
    }
  });

  console.log(`[Sanity] active \u2728 profile="${profile.name}"`);
})();
