// Sanity AI — custom "watch these sites" module (loaded before popup.js).
window.SanityMods = window.SanityMods || {};
window.SanityMods.initSites = function ({ canMessage }) {
  let pendingSite = null;   // the current tab's domain, ready to one-tap add
  let lastUserSites = [];   // cached list of user-added sites

  // ── Custom sites (user-added) ──
  function normalizeSite(input) {
    let v = (input || "").trim();
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = "https://" + v;
    let u; try { u = new URL(v); } catch (e) { return null; }
    if (u.protocol !== "https:") return null;
    const host = u.hostname;
    if (!host || !host.includes(".")) return null;
    return { origin: "https://" + host + "/*", host };
  }
  function renderUserSites(sites) {
    lastUserSites = sites || [];
    const box = document.getElementById("userSites");
    if (!box) return;
    box.innerHTML = "";
    (sites || []).forEach((s) => {
      const row = document.createElement("div"); row.className = "user-site";
      const h = document.createElement("div"); h.className = "u-host"; h.textContent = s.host;
      const x = document.createElement("button"); x.className = "u-remove"; x.textContent = "\u2715"; x.title = "Remove"; x.setAttribute("aria-label", "Remove " + s.host);
      x.addEventListener("click", () => {
        if (canMessage) chrome.runtime.sendMessage({ type: "removeUserSite", origin: s.origin }, (res) => { renderUserSites(res && res.sites); refreshCurrentSite(); });
      });
      row.append(h, x); box.appendChild(row);
    });
  }

  // Ask for the active tab defensively: some Chromium forks (Dia/Arc) answer
  // side-panel queries differently — or not at all. currentWindow is the panel's
  // host window (the right semantics); lastFocusedWindow is the fallback; and a
  // watchdog guarantees the UI never sticks on "Detecting…".
  function queryActiveTab(cb) {
    let answered = false;
    const finish = (tab) => { if (!answered) { answered = true; try { cb(tab || null); } catch (e) {} } };
    setTimeout(() => finish(null), 900); // watchdog: no callback ever → give up gracefully
    const attempt = (opts, next) => {
      try {
        chrome.tabs.query(opts, (tabs) => {
          if (!chrome.runtime.lastError && tabs && tabs[0] && tabs[0].url) { finish(tabs[0]); return; }
          next ? next() : finish(null);
        });
      } catch (e) { next ? next() : finish(null); }
    };
    attempt({ active: true, currentWindow: true }, () => attempt({ active: true, lastFocusedWindow: true }, null));
  }

  function refreshCurrentSite() {
    const btn = document.getElementById("addCurrentBtn");
    if (!btn) return;
    if (!(chrome.tabs && chrome.tabs.query)) { btn.style.display = "none"; return; }
    queryActiveTab((t) => {
      let host = null;
      try { const u = new URL(t && t.url); if (u.protocol === "https:") host = u.hostname; } catch (e) {}
      if (!host) { pendingSite = null; btn.disabled = true; btn.textContent = "Open an https site to add it \u2014 or type one below"; return; }
      if (SAN.BUILTIN_RE.test(host)) { pendingSite = null; btn.disabled = true; btn.textContent = "\u201C" + host + "\u201D is already built in"; return; }
      if (lastUserSites.some((s) => s.host === host)) { pendingSite = null; btn.disabled = true; btn.textContent = "Already watching " + host; return; }
      pendingSite = { origin: "https://" + host + "/*", host };
      btn.disabled = false; btn.textContent = "\uFF0B Watch \u201C" + host + "\u201D";
    });
  }

  (function initUserSites() {
    const input = document.getElementById("addSiteInput");
    const btn = document.getElementById("addSiteBtn");
    const cur = document.getElementById("addCurrentBtn");
    const err = document.getElementById("addSiteErr");
    const showErr = (m) => { if (err) { err.textContent = m || ""; err.style.display = m ? "block" : "none"; } };
    const grantAndAdd = (parsed) => {
      if (!(chrome.permissions && chrome.permissions.request)) { showErr("Not supported in this browser."); return; }
      const doAdd = () => {
        chrome.runtime.sendMessage({ type: "addUserSite", origin: parsed.origin, host: parsed.host }, (res) => {
          if (chrome.runtime.lastError) { showErr("Couldn't reach the extension \u2014 try reloading it."); return; }
          if (input) input.value = "";
          renderUserSites(res && res.sites);
          refreshCurrentSite();
        });
      };
      // Permission prompts are only reliable when anchored to a real extension
      // TAB. From a side panel or popup, some Chromium forks (Dia, Arc) simply
      // never show the prompt — the callback never fires and the click feels
      // dead. So the grant always happens on grant.html; when the permission
      // is already there (e.g. re-adding after remove), skip straight to add.
      const openGrantTab = () => {
        try { chrome.runtime.sendMessage({ type: "dlog", msg: "sites: opening grant tab", data: { origin: parsed.origin } }); } catch (e) {}
        try {
          chrome.tabs.create({
            url: chrome.runtime.getURL("grant.html") + "?origin=" + encodeURIComponent(parsed.origin) + "&host=" + encodeURIComponent(parsed.host),
            active: true,
          });
        } catch (e) { showErr("Couldn't open the grant page" + (e && e.message ? " (" + e.message + ")" : "") + "."); }
      };
      try {
        chrome.permissions.contains({ origins: [parsed.origin] }, (has) => {
          if (!chrome.runtime.lastError && has) doAdd(); else openGrantTab();
        });
      } catch (e) { openGrantTab(); }
    };
    // One-tap: add the site the user is currently on (domain auto-detected).
    if (cur) cur.addEventListener("click", () => { showErr(""); if (pendingSite) grantAndAdd(pendingSite); });
    // Manual entry (for a site you're not currently on).
    if (input && btn) {
      const add = () => { showErr(""); const parsed = normalizeSite(input.value); if (!parsed) { showErr("Enter a valid site, e.g. perplexity.ai"); return; } grantAndAdd(parsed); };
      btn.addEventListener("click", add);
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
    }
    if (canMessage) chrome.runtime.sendMessage({ type: "listUserSites" }, (res) => { if (!chrome.runtime.lastError) renderUserSites(res && res.sites); refreshCurrentSite(); });
    // The grant tab adds sites out-of-band — mirror the change here live.
    try {
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === "local" && ch.userSites) { renderUserSites(ch.userSites.newValue || []); refreshCurrentSite(); }
      });
    } catch (e) {}
    // Keep the detected site fresh as the user switches tabs/windows.
    refreshCurrentSite();
    try { chrome.tabs.onActivated.addListener(refreshCurrentSite); } catch (e) {}
    try { chrome.tabs.onUpdated.addListener((id, info, tab) => { if (tab && tab.active && (info.url || info.status === "complete")) refreshCurrentSite(); }); } catch (e) {}
    window.addEventListener("focus", refreshCurrentSite);
  })();

};
