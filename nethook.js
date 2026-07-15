// Sanity — network hook (runs in the page's MAIN world, document_start).
//
// Reports "an agent request is in flight / has finished" to the isolated
// content script via window.postMessage. This is more robust than scraping the
// DOM (CSS classes change every redesign; network endpoints rarely do) and it
// works even while the tab is backgrounded.
//
// Per host we list which request means "the agent is generating":
//   • via "xhr"   — the whole generation rides on one XHR (Gemini)
//   • via "fetch" — an SSE stream; we tee the body to detect when it closes
// Everything is wrapped in try/catch and falls back to the untouched original,
// so a hook failure can never break the host page.
(() => {
  "use strict";

  // Injected twice (document_start + the on-update re-inject)? Never wrap twice.
  if (window.__sanityNetHook) return;
  window.__sanityNetHook = true;

  const HOSTS = {
    "bit.cloud":        [{ re: /\/hope\/api\/prompt\b/i, via: "fetch", method: "POST" }], // api.v2.bit.cloud/hope/api/prompt (SSE)
    "gemini.google.com": [{ re: /StreamGenerate/i, via: "xhr" }],
    "claude.ai":        [{ re: /chat_conversations\/[^/]+\/(retry_)?completion/i, via: "fetch", method: "POST" }],
    "chatgpt.com":      [{ re: /\/backend-api\/(f\/)?conversation\b/i, via: "fetch", method: "POST" }],
    "chat.openai.com":  [{ re: /\/backend-api\/(f\/)?conversation\b/i, via: "fetch", method: "POST" }],
  };
  // Subdomains of bit.cloud (e.g. main.lanes.bit.cloud) run Hope too.
  const rules = HOSTS[location.host]
    || (/(^|\.)bit\.cloud$/i.test(location.host) ? HOSTS["bit.cloud"] : null);
  if (!rules) return;

  const needXhr = rules.some((r) => r.via === "xhr");
  const needFetch = rules.some((r) => r.via === "fetch");

  let active = 0;
  function emit() {
    try { window.postMessage({ __sanity: true, type: "net", active: active > 0 }, location.origin); } catch {}
  }
  function matches(url, method, via) {
    const m = (method || "GET").toUpperCase();
    return rules.some((r) => r.via === via && (!r.method || r.method === m) && r.re.test(String(url)));
  }
  function tracker() {
    let settled = false;
    active++; emit();
    return () => { if (!settled) { settled = true; active = Math.max(0, active - 1); emit(); } };
  }

  // ── XHR (Gemini) — installed only where an XHR rule exists, so this file
  // never shows up in stack traces of unrelated requests on other hosts. ──
  if (needXhr) {
  const xopen = XMLHttpRequest.prototype.open;
  const xsend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__sanity = matches(url, method, "xhr"); } catch { this.__sanity = false; }
    return xopen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    if (this.__sanity && !this.__sanityTracked) {
      this.__sanityTracked = true;
      const done = tracker();
      this.addEventListener("loadend", done, { once: true });
    }
    return xsend.apply(this, arguments);
  };

  }

  // ── fetch (Claude / ChatGPT, SSE streams) — installed only where a fetch
  // rule exists. On Gemini we don't touch fetch at all: the page's own CSP
  // blocks its ad beacons, and a wrapper would put us in those stack traces. ──
  if (needFetch) {
  const ofetch = window.fetch;
  if (typeof ofetch === "function") {
    window.fetch = function (input, init) {
      let url = "", method = "GET";
      try {
        if (typeof input === "string") url = input;
        else if (input) { url = input.url || ""; method = input.method || method; }
        if (init && init.method) method = init.method;
      } catch {}
      const p = ofetch.apply(this, arguments);
      if (!matches(url, method, "fetch")) return p;

      const done = tracker();
      const t0 = Date.now(); // user submitted (request fired)
      let startSent = false;
      const emitStart = () => {
        if (startSent) return; startSent = true;
        // Time from prompt submission to the first streamed byte = how long the
        // agent took to actually start. Reported once, stored locally only.
        try { window.postMessage({ __sanity: true, type: "net-start", latencyMs: Date.now() - t0 }, location.origin); } catch {}
      };
      // The user's prompt, extracted from the request body (stays on-device;
      // ends up only in the local run log / CSV export).
      try {
        const emitPrompt = (text) => {
          if (!text) return;
          try { window.postMessage({ __sanity: true, type: "net-prompt", text: String(text).slice(0, 300) }, location.origin); } catch {}
        };
        const extract = (raw) => {
          try {
            const o = JSON.parse(raw);
            const KEY = /prompt|message|text|input|content|question|query/i;
            const walk = (v, depth, underKey) => {
              if (depth > 4 || v == null) return null;
              if (typeof v === "string") return (underKey && v.trim().length >= 2) ? v : null;
              if (Array.isArray(v)) { for (const x of v) { const r = walk(x, depth + 1, underKey); if (r) return r; } return null; }
              if (typeof v === "object") {
                const ks = Object.keys(v);
                // prompt-ish branches first, then the rest (payload wrappers etc.)
                for (const k of ks) if (KEY.test(k)) { const r = walk(v[k], depth + 1, true); if (r) return r; }
                for (const k of ks) if (!KEY.test(k)) { const r = walk(v[k], depth + 1, underKey); if (r) return r; }
              }
              return null;
            };
            return walk(o, 0, false);
          } catch { return typeof raw === "string" ? raw : null; }
        };
        const body = init && init.body;
        if (typeof body === "string") emitPrompt(extract(body));
        else if (input && typeof input !== "string" && typeof input.clone === "function") {
          input.clone().text().then((txt) => emitPrompt(extract(txt))).catch(() => {});
        }
      } catch {}
      return p.then((resp) => {
        try {
          if (!resp || !resp.body || resp.status < 200 || resp.status >= 300) { done(); return resp; }
          // tee: the app reads one branch untouched; we drain the other to learn
          // exactly when the server closes the stream (= generation finished).
          const [appStream, monStream] = resp.body.tee();
          (async () => {
            const reader = monStream.getReader();
            try { for (;;) { const { done: d } = await reader.read(); emitStart(); if (d) break; } } catch {}
            done();
          })();
          return new Response(appStream, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
        } catch (e) { done(); return resp; } // never break the page
      }).catch((err) => { done(); throw err; });
    };
  }

  }

  // Startup handshake: answer the content script with the current state.
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data && e.data.__sanity && e.data.type === "net-query") emit();
  });
  emit();
})();
