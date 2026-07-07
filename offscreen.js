// Sanity — offscreen document.
// It plays the completion chime AND renders the OS notification. The offscreen
// document is a real extension page (DOM context), so the standard Web
// Notifications API (`new Notification()`) works here and the browser bridges it
// to the OS natively — unlike chrome.notifications / SW showNotification, which
// Dia doesn't bridge from a service-worker context.

const openNotifications = new Map(); // tabId -> Notification

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "play-chime") { playChime(); return; }
  if (msg.type === "show-notification") { sendResponse({ shown: showNotification(msg) }); return; }
  if (msg.type === "close-notification") { closeNotification(msg.tabId); return; }
});

function showNotification(msg) {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
    if (openNotifications.has(msg.tabId)) { try { openNotifications.get(msg.tabId).close(); } catch (e) {} }
    const n = new Notification(msg.title, { body: msg.body, icon: msg.icon, requireInteraction: true, tag: "sanity-" + msg.tabId });
    n.onclick = () => {
      chrome.runtime.sendMessage({ type: "focusTab", tabId: msg.tabId, url: msg.url });
      try { n.close(); } catch (e) {}
      openNotifications.delete(msg.tabId);
    };
    n.onclose = () => openNotifications.delete(msg.tabId);
    if (typeof msg.tabId === "number") openNotifications.set(msg.tabId, n);
    return true;
  } catch (e) {
    console.warn("[Sanity] offscreen notification failed:", e && e.message);
    return false;
  }
}

function closeNotification(tabId) {
  const n = openNotifications.get(tabId);
  if (n) { try { n.close(); } catch (e) {} openNotifications.delete(tabId); }
}

function playChime() {
  let ctx;
  try {
    ctx = new (self.AudioContext || self.webkitAudioContext)();
  } catch (e) {
    console.warn("[Sanity] offscreen audio unavailable:", e && e.message);
    return;
  }
  const go = () => {
    const now = ctx.currentTime;
    const notes = [
      { f: 523.25, d: 0.0,  v: 0.25 }, // C5
      { f: 659.25, d: 0.12, v: 0.22 }, // E5
      { f: 783.99, d: 0.24, v: 0.18 }, // G5
    ];
    for (const { f, d, v } of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, now + d);
      gain.gain.linearRampToValueAtTime(v, now + d + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + d + 0.8);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + d);
      osc.stop(now + d + 0.9);
    }
    setTimeout(() => ctx.close().catch(() => {}), 2000);
  };
  ctx.state === "suspended" ? ctx.resume().then(go).catch(go) : go();
}
