// Sanity AI — grant page. Permission prompts are only reliable when anchored
// to a real extension tab (side panels/popups silently never show them on
// some Chromium forks — Dia, Arc). The panel opens this page; the click here
// is the user gesture the prompt needs.
//
// Dia (observed in the field): chrome.permissions.request() never resolves at
// all — no prompt, no callback, even from a tab. So a watchdog detects the
// hang, shows the manual site-access path, and a poller completes the add the
// moment the permission appears (however it was granted).
(() => {
  "use strict";
  const params = new URLSearchParams(location.search);
  const origin = params.get("origin") || "";
  const host = params.get("host") || origin.replace(/^https:\/\//, "").replace(/\/\*$/, "");
  const btn = document.getElementById("grantBtn");
  const statusEl = document.getElementById("status");
  const manualEl = document.getElementById("manual");
  const hostEl = document.getElementById("host");
  if (hostEl && host) hostEl.textContent = host;
  document.querySelectorAll(".mhost").forEach((el) => { el.textContent = host; });

  function show(msg, ok) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = "status " + (ok ? "ok" : "err");
  }
  function log(msg, data) {
    try { chrome.runtime.sendMessage({ type: "dlog", msg: "grant: " + msg, data }); } catch (e) {}
  }

  // Only exact "https://host/*" origins minted by the panel are accepted.
  const valid = /^https:\/\/[a-z0-9.-]+\/\*$/i.test(origin);
  if (!valid) {
    if (btn) btn.disabled = true;
    show("Missing or invalid site — close this tab and try again from the panel.", false);
    return;
  }

  let settled = false; // the add finished (or a hard error) — stop watchdog/poll
  function completeAdd(how) {
    if (settled) return;
    settled = true;
    chrome.runtime.sendMessage({ type: "addUserSite", origin, host }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        settled = false;
        log("add-failed", { how, err: chrome.runtime.lastError && chrome.runtime.lastError.message });
        show("Access granted, but adding the site failed — try once more.", false);
        if (btn) btn.disabled = false;
        return;
      }
      log("added", { host, how });
      show("Watching " + host + ". You can close this tab.", true);
      if (btn) { btn.disabled = true; btn.textContent = "Done"; }
      if (manualEl) manualEl.style.display = "none";
      setTimeout(() => { try { window.close(); } catch (e) {} }, 1400);
    });
  }

  // Poll for the permission appearing by ANY route (the normal prompt, or the
  // browser's manual per-site access UI). Cheap, local, self-terminating.
  let polls = 0;
  const poller = setInterval(() => {
    if (settled || ++polls > 150) { if (settled || polls > 150) clearInterval(poller); return; } // ~5 min
    try {
      chrome.permissions.contains({ origins: [origin] }, (has) => {
        if (has && !settled) { log("granted-detected", { via: "poll" }); clearInterval(poller); completeAdd("poll"); }
      });
    } catch (e) {}
  }, 2000);

  btn.addEventListener("click", () => {
    btn.disabled = true;
    show("", true); if (statusEl) statusEl.className = "status";
    log("requesting", { origin });
    // Watchdog: on browsers where request() never resolves (Dia), reveal the
    // manual path after 4s. The poller above completes the add automatically
    // once the permission shows up.
    const watchdog = setTimeout(() => {
      if (settled) return;
      log("watchdog", { note: "permissions.request never called back" });
      btn.disabled = false;
      if (manualEl) manualEl.style.display = "block";
      show("This browser didn’t show the permission prompt.", false);
    }, 4000);
    try {
      chrome.permissions.request({ origins: [origin] }, (granted) => {
        clearTimeout(watchdog);
        if (settled) return;
        if (chrome.runtime.lastError) {
          btn.disabled = false;
          log("request-error", { err: chrome.runtime.lastError.message });
          show("The permission prompt failed: " + chrome.runtime.lastError.message, false);
          return;
        }
        if (!granted) {
          btn.disabled = false;
          log("denied");
          show("Access wasn’t granted — nothing was added.", false);
          return;
        }
        log("granted-detected", { via: "prompt" });
        completeAdd("prompt");
      });
    } catch (e) {
      clearTimeout(watchdog);
      btn.disabled = false;
      log("request-threw", { err: e && e.message });
      show("This browser blocked the prompt" + (e && e.message ? " (" + e.message + ")" : "") + ".", false);
      if (manualEl) manualEl.style.display = "block";
    }
  });
})();
