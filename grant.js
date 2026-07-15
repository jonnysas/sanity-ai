// Sanity AI — grant page. Permission prompts are only reliable when anchored
// to a real extension tab (side panels/popups silently never show them on
// some Chromium forks — Dia, Arc). The panel opens this page; the click here
// is the user gesture the prompt needs.
(() => {
  "use strict";
  const params = new URLSearchParams(location.search);
  const origin = params.get("origin") || "";
  const host = params.get("host") || origin.replace(/^https:\/\//, "").replace(/\/\*$/, "");
  const btn = document.getElementById("grantBtn");
  const statusEl = document.getElementById("status");
  const hostEl = document.getElementById("host");
  if (hostEl && host) hostEl.textContent = host;

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

  btn.addEventListener("click", () => {
    btn.disabled = true;
    log("requesting", { origin });
    try {
      chrome.permissions.request({ origins: [origin] }, (granted) => {
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
        chrome.runtime.sendMessage({ type: "addUserSite", origin, host }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) {
            btn.disabled = false;
            log("add-failed", { err: chrome.runtime.lastError && chrome.runtime.lastError.message });
            show("Access granted, but adding the site failed — try once more.", false);
            return;
          }
          log("added", { host });
          show("Watching " + host + ". You can close this tab.", true);
          btn.textContent = "Done";
          setTimeout(() => { try { window.close(); } catch (e) {} }, 1400);
        });
      });
    } catch (e) {
      btn.disabled = false;
      log("request-threw", { err: e && e.message });
      show("This browser blocked the prompt" + (e && e.message ? " (" + e.message + ")" : "") + ".", false);
    }
  });
})();
