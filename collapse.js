// Sanity — Collapsible AI responses on Hope AI session pages (opt-in).
//
// Isolated from the monitor (content.js). OFF by default. Turning it off — or an
// extension reload (self-heal) — fully restores the page. Only inline styles +
// its own nodes; never removes or re-parents Hope's nodes (safe for React).
//
// SIMPLE model: each AI response is independently collapsible. No card frames,
// no borders, no sticky headers (those fought Hope's real DOM). A hover-revealed
// chevron on each question folds/unfolds its answer into a one-line preview.
//
// Hope virtualizes / lazy-loads the transcript (nodes mount, unmount, re-render),
// so fold state lives in JS keyed by the question text and is RECONCILED on every
// mutation — re-applied to whatever is mounted. That's why scrolling no longer
// resurrects unfolded answers.
//
// Detection: message → hope-console_sessionMessage__ ; USER → also humanMessage__
(function () {
  "use strict";
  // Injected twice (manifest + the on-update re-inject in the SW)? No-op.
  if (window.__sanityCollapseLoaded) return;
  window.__sanityCollapseLoaded = true;
  const PREF_KEY = "collapse";
  // The script now loads on all of bit.cloud (so SPA entry into a session is
  // caught) — but it must only act on session pages.
  const onSession = () => location.pathname.startsWith("/hope/session/");
  const DEBUG = false;
  const log = (...a) => { if (DEBUG) console.log("[Sanity/collapse]", ...a); };

  const RE_MSG = /hope-console_sessionMessage__/;
  const RE_USER = /hope-console_humanMessage__/;
  const SEL_MSG = '[class*="hope-console_sessionMessage__"]';
  const ACCENT = "#6d5efc";

  let enabled = false;
  let container = null;
  let observer = null;
  let debounceTimer = null;
  let heartbeat = null;
  let keyHandler = null;
  let visHandler = null;

  let expandAllActive = false;
  const expandedKeys = new Set();   // turns the user explicitly opened
  const collapsedKeys = new Set();  // turns the user explicitly closed (incl. collapse-all)

  function contextAlive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }

  // SPA navigation: entering a session arms the feature; leaving restores the
  // page and reports "not reading" so the panel box hides.
  let lastPath = location.pathname;
  function onNav() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (!enabled) return;
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    restorePage(); container = null;
    expandAllActive = false; expandedKeys.clear(); collapsedKeys.clear();
    if (onSession()) waitForContainer(0);
    else if (contextAlive()) { try { chrome.runtime.sendMessage({ type: "hopeReading", data: { enabled: false } }); } catch (e) {} }
  }
  window.addEventListener("popstate", () => setTimeout(onNav, 0));
  if (window.navigation && window.navigation.addEventListener) {
    try { window.navigation.addEventListener("navigate", () => setTimeout(onNav, 0)); } catch (e) {}
  }

  try {
    chrome.storage.local.get([PREF_KEY], (r) => { enabled = !!(r && r[PREF_KEY] === true); if (enabled) start(); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[PREF_KEY]) {
        const on = changes[PREF_KEY].newValue === true;
        if (on !== enabled) { enabled = on; on ? start() : stop(); }
      }
    });
    // Panel commands arrive as targeted messages (relayed by the SW) —
    // session storage stays trusted-only.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "hopeCmd") handleCmd(msg);
    });
  } catch (e) {}

  function classOf(el) { const c = el && el.className; return ((c && c.baseVal !== undefined) ? c.baseVal : c) || ""; }
  function isMsg(el) { return RE_MSG.test(classOf(el)); }
  function isUserMsg(el) { return RE_USER.test(classOf(el)); }

  function start() {
    log("start");
    keyHandler = (e) => { if (enabled && e.altKey && (e.key === "c" || e.key === "C")) { e.preventDefault(); toggleAll(); } };
    document.addEventListener("keydown", keyHandler, true);
    visHandler = () => { if (!document.hidden && enabled && container) onVisible(); };
    document.addEventListener("visibilitychange", visHandler);
    expandAllActive = false; expandedKeys.clear(); collapsedKeys.clear();
    heartbeat = setInterval(() => { if (!contextAlive()) { selfHeal(); return; } if (location.pathname !== lastPath) { onNav(); return; } writeStatus(); }, 15000);
    if (onSession()) waitForContainer(0);
  }

  function stop() {
    log("stop");
    if (observer) { observer.disconnect(); observer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (keyHandler) { document.removeEventListener("keydown", keyHandler, true); keyHandler = null; }
    if (visHandler) { document.removeEventListener("visibilitychange", visHandler); visHandler = null; }
    restorePage();
    if (contextAlive()) { try { chrome.runtime.sendMessage({ type: "hopeReading", data: { enabled: false } }); } catch (e) {} }
    container = null;
  }

  function selfHeal() {
    log("self-heal (context invalidated)");
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    restorePage();
    container = null;
  }

  function restorePage() {
    document.querySelectorAll("[data-sanity-collapsed]").forEach((el) => {
      el.style.maxHeight = ""; el.style.opacity = ""; el.style.overflow = ""; el.style.transition = "";
      el.style.paddingTop = ""; el.style.paddingBottom = ""; el.style.marginTop = ""; el.style.marginBottom = "";
      el.removeAttribute("data-sanity-collapsed");
    });
    document.querySelectorAll("[data-sanity-preview]").forEach((p) => p.remove());
    document.querySelectorAll("[data-sanity-chev]").forEach((c) => c.remove());
    document.querySelectorAll("[data-sanity-um]").forEach((el) => {
      if (el.__sanityIn) { el.removeEventListener("mouseenter", el.__sanityIn); el.removeEventListener("mouseleave", el.__sanityOut); el.__sanityIn = el.__sanityOut = null; }
      el.removeAttribute("data-sanity-um"); el.removeAttribute("data-sanity-state");
    });
  }

  function waitForContainer(attempt) {
    if (!enabled) return;
    container = findContainer();
    if (container) { log("container", container); reconcile(); attachObserver(); }
    else if (attempt < 30) setTimeout(() => waitForContainer(attempt + 1), 500);
    else log("messages container not found");
  }

  function findContainer() { const first = document.querySelector(SEL_MSG); return first ? first.parentElement : null; }
  function userMessages() { return container ? Array.from(container.children).filter((el) => el.getAttribute("data-sanity-um") === "1") : []; }

  function aiGroupAfter(userEl) {
    const out = [];
    let n = userEl.nextElementSibling;
    while (n) {
      if (n.hasAttribute("data-sanity-preview")) { n = n.nextElementSibling; continue; }
      if (isUserMsg(n)) break;
      if (isMsg(n)) out.push(n);
      n = n.nextElementSibling;
    }
    return out;
  }

  function textKey(userEl) {
    const msg = userEl.querySelector('[class*="hope-console_message__"]');
    let q = ((msg ? msg.textContent : userEl.textContent) || "").replace(/\u25B8/g, "");
    q = q.replace(/\s+/g, " ").trim().slice(0, 60);
    const ai = aiGroupAfter(userEl);
    const a = (ai[0] ? ai[0].textContent : "").replace(/\s+/g, " ").trim().slice(0, 40);
    return q + "::" + a;
  }

  function summary(els) {
    let t = "";
    for (const el of els) { t += " " + (el.textContent || ""); if (t.length > 240) break; }
    t = t.replace(/\s+/g, " ").trim();
    const m = t.match(/^(.{0,150}?[.!?])(\s|$)/);
    return (m ? m[1] : t.slice(0, 130)).trim() || "AI response";
  }

  // ── Reconcile: idempotent; re-applies fold state to whatever is mounted. ──
  function reconcile() {
    if (!container) return;
    for (const el of Array.from(container.children)) {
      if (isUserMsg(el) && !el.hasAttribute("data-sanity-um")) {
        el.setAttribute("data-sanity-um", "1");
        el.setAttribute("data-sanity-state", "expanded");
        addChevron(el);
      }
    }
    const ums = userMessages();
    const keepOpen = new Set(ums.slice(-2)); // the two most recent stay open by default
    for (const el of ums) applyCollapse(el, !desiredExpanded(el, keepOpen.has(el)));
    writeStatus();
  }

  function desiredExpanded(userEl, defaultOpen) {
    if (expandAllActive) return true;
    const k = textKey(userEl);
    if (collapsedKeys.has(k)) return false;
    if (expandedKeys.has(k)) return true;
    return !!defaultOpen; // Focus: the two most recent stay open by default
  }

  // A small hover-revealed chevron on the question — the only added chrome.
  function addChevron(userEl) {
    if (userEl.querySelector(":scope > [data-sanity-chev]")) return;
    const c = document.createElement("button");
    c.setAttribute("data-sanity-chev", "1");
    c.title = "Fold / unfold this reply (\u2325C for all)";
    c.style.cssText =
      "all:initial;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;" +
      "margin-inline-start:auto;align-self:center;border-radius:6px;color:" + ACCENT + ";font-size:11px;flex:0 0 auto;" +
      "opacity:0;pointer-events:none;transition:opacity .15s,transform .2s;transform:rotate(90deg);";
    c.textContent = "\u25B8";
    c.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); toggle(userEl); });
    userEl.appendChild(c);
    const show = () => { c.style.opacity = ".7"; c.style.pointerEvents = "auto"; };
    const hide = () => { c.style.opacity = "0"; c.style.pointerEvents = "none"; };
    userEl.__sanityIn = show; userEl.__sanityOut = hide;
    userEl.addEventListener("mouseenter", show);
    userEl.addEventListener("mouseleave", hide);
  }

  function applyCollapse(userEl, collapsed) {
    const target = collapsed ? "collapsed" : "expanded";
    if (userEl.getAttribute("data-sanity-state") === target && (!collapsed || userEl.__sanityPreview)) return;
    const body = aiGroupAfter(userEl);
    const animate = !document.hidden; // never measure/animate on a hidden tab — scrollHeight is unreliable there
    for (const el of body) {
      if (collapsed && !el.hasAttribute("data-sanity-collapsed")) {
        el.setAttribute("data-sanity-collapsed", "1");
        if (animate) {
          el.style.transition = "max-height .3s ease, opacity .22s ease, padding .3s ease, margin .3s ease";
          el.style.overflow = "hidden"; el.style.maxHeight = el.scrollHeight + "px"; void el.offsetHeight;
        } else { el.style.transition = ""; el.style.overflow = "hidden"; }
        el.style.maxHeight = "0px"; el.style.opacity = "0"; el.style.paddingTop = "0px"; el.style.paddingBottom = "0px"; el.style.marginTop = "0px"; el.style.marginBottom = "0px";
      } else if (!collapsed && el.hasAttribute("data-sanity-collapsed")) {
        el.removeAttribute("data-sanity-collapsed");
        el.style.paddingTop = ""; el.style.paddingBottom = ""; el.style.marginTop = ""; el.style.marginBottom = "";
        if (animate) {
          el.style.maxHeight = el.scrollHeight + "px"; el.style.opacity = "1";
          setTimeout(() => { el.style.maxHeight = ""; el.style.overflow = ""; el.style.transition = ""; }, 320);
        } else { el.style.maxHeight = ""; el.style.overflow = ""; el.style.transition = ""; el.style.opacity = ""; }
      }
    }
    if (userEl.__sanityPreview) { userEl.__sanityPreview.remove(); userEl.__sanityPreview = null; }
    if (collapsed && body.length) {
      const p = document.createElement("div");
      p.setAttribute("data-sanity-preview", "1");
      p.style.cssText =
        "all:initial;display:flex;align-items:center;gap:8px;cursor:pointer;box-sizing:border-box;" +
        "margin:2px 0 10px;padding:3px 0 3px 10px;border-left:2px solid " + ACCENT + "55;" +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;";
      const txt = document.createElement("span");
      txt.style.cssText = "flex:1;min-width:0;color:#9a9aa4;font-style:italic;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      txt.textContent = summary(body);
      const hint = document.createElement("span");
      hint.style.cssText = "flex:0 0 auto;color:" + ACCENT + ";font-size:11px;font-weight:600;opacity:.85;";
      hint.textContent = "expand \u203A";
      p.append(txt, hint);
      p.addEventListener("click", (e) => { e.stopPropagation(); toggle(userEl); });
      userEl.insertAdjacentElement("afterend", p);
      userEl.__sanityPreview = p;
    }
    userEl.setAttribute("data-sanity-state", target);
    const chev = userEl.querySelector(":scope > [data-sanity-chev]");
    if (chev) chev.style.transform = "rotate(" + (collapsed ? "0" : "90") + "deg)";
  }

  function toggle(userEl) {
    const k = textKey(userEl);
    const isExpanded = userEl.getAttribute("data-sanity-state") !== "collapsed";
    if (isExpanded) {
      if (expandAllActive) { expandAllActive = false; userMessages().forEach((el) => { if (el !== userEl) expandedKeys.add(textKey(el)); }); }
      expandedKeys.delete(k); collapsedKeys.add(k);
    } else {
      collapsedKeys.delete(k); expandedKeys.add(k);
    }
    pauseObserver(reconcile);
  }
  function collapseAll() {
    expandAllActive = false; expandedKeys.clear();
    userMessages().slice(-2).forEach((el) => collapsedKeys.add(textKey(el))); // override the two default-open turns
    pauseObserver(reconcile);
  }
  function expandAll() { expandAllActive = true; collapsedKeys.clear(); pauseObserver(reconcile); }
  function toggleAll() {
    const anyExpanded = userMessages().some((el) => el.getAttribute("data-sanity-state") !== "collapsed");
    anyExpanded ? collapseAll() : expandAll();
  }
  function resetFocus() { expandAllActive = false; expandedKeys.clear(); collapsedKeys.clear(); pauseObserver(reconcile); }

  // Returning to a tab: clear any stale inline sizing left from while it was
  // hidden (so a backgrounded tab can't come back clipped), then reconcile fresh.
  function onVisible() {
    document.querySelectorAll("[data-sanity-um]").forEach((u) => {
      aiGroupAfter(u).forEach((el) => {
        if (!el.hasAttribute("data-sanity-collapsed")) {
          el.style.maxHeight = ""; el.style.overflow = ""; el.style.transition = ""; el.style.opacity = "";
          el.style.paddingTop = ""; el.style.paddingBottom = ""; el.style.marginTop = ""; el.style.marginBottom = "";
        }
      });
    });
    pauseObserver(reconcile);
  }

  // Global Collapse all / Expand all live ONLY in the popup and side panel
  // (the "Reading on Hope" control) — no floating control on the page. On-page
  // you fold per-reply via the chevron, or fold/unfold everything with ⌥C.

  // ── Side-panel command channel (session broadcast). Scoped to the tab you're
  // actually looking at: a hidden tab neither reports status nor obeys panel
  // commands, so multiple Hope tabs can't break each other. ──
  function writeStatus() {
    if (!contextAlive() || document.hidden || !onSession()) return;
    try {
      const ums = userMessages();
      const collapsed = ums.filter((el) => el.getAttribute("data-sanity-state") === "collapsed").length;
      chrome.runtime.sendMessage({ type: "hopeReading", data: { enabled: true, collapsed, total: ums.length } });
    } catch (e) {}
  }
  function handleCmd(cmd) {
    if (!enabled || document.hidden || !cmd || !cmd.action) return; // only the visible tab obeys
    if (cmd.action === "collapseAll") collapseAll();
    else if (cmd.action === "expandAll") expandAll();
    else if (cmd.action === "toggleAll") toggleAll();
    else if (cmd.action === "focusOn") resetFocus();
  }

  function attachObserver() {
    if (observer || !container) return;
    observer = new MutationObserver(() => {
      if (!contextAlive()) { selfHeal(); return; }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => { if (enabled && container) pauseObserver(reconcile); }, 800);
    });
    observer.observe(container, { childList: true });
  }
  function pauseObserver(fn) {
    if (observer) observer.disconnect();
    try { fn(); } finally { if (observer && enabled && container) observer.observe(container, { childList: true }); }
  }
})();
