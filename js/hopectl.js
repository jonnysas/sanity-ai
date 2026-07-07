// Sanity AI — "Reading on Hope" control module (loaded before popup.js).
window.SanityMods = window.SanityMods || {};
window.SanityMods.initHopeCtl = function ({ canMessage }) {
  // ── Hope reading control: panel ↔ page bridge over session storage ──
  function sendHopeCmd(action) {
    if (!canMessage) return;
    try { chrome.runtime.sendMessage({ type: "hopeCmd", action }); } catch (e) {}
  }
  function renderHopeCtl() {
    const box = document.getElementById("hopeCtl");
    if (!box) return;
    if (!chrome.storage || !chrome.storage.session) { box.style.display = "none"; return; }
    chrome.storage.session.get("hopeReading", (r) => {
      const s = r && r.hopeReading;
      const fresh = s && s.enabled && (Date.now() - (s.ts || 0) < 45000);
      if (!fresh) { box.style.display = "none"; box.textContent = ""; return; }
      box.style.display = "";
      box.innerHTML =
        '<div class="hc-top"><span class="hc-dot"></span><span class="hc-label">Reading on Hope</span>' +
        '<span class="hc-count">' + (s.collapsed || 0) + "/" + (s.total || 0) + ' folded</span></div>' +
        '<div class="hc-acts"><button class="hc-b" id="hcCollapse">Collapse all</button>' +
        '<button class="hc-b" id="hcExpand">Expand all</button></div>';
      const c = box.querySelector("#hcCollapse"), e = box.querySelector("#hcExpand");
      if (c) c.addEventListener("click", () => sendHopeCmd("collapseAll"));
      if (e) e.addEventListener("click", () => sendHopeCmd("expandAll"));
    });
  }

  return { render: renderHopeCtl };
};
