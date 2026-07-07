// Sanity AI — shared constants (loaded before other scripts in every context).
// Keep this file dependency-free; it only defines the SAN global.
// `var` + reuse-if-present: the file may be injected twice into the same world
// (manifest + the SW's on-update re-inject) — a `const` here would throw and
// could take the rest of the injection batch down with it.
var SAN = globalThis.SAN || {
  // Message types (runtime messaging)
  MSG: {
    AGENT: "agent",                 // content -> SW: phase reports (working/done/blocked)
    GET_STATE: "getState",
    PANEL_PING: "panelPing",
    FOCUS_TAB: "focusTab",
    DISMISS: "dismiss",
    CLEAR_HISTORY: "clearHistory",
    CLEAR_HISTORY_ITEM: "clearHistoryItem",
    LIST_USER_SITES: "listUserSites",
    ADD_USER_SITE: "addUserSite",
    REMOVE_USER_SITE: "removeUserSite",
    TOAST: "sanityToast",           // SW -> active tab content script
    HOPE_CMD: "hopeCmd",            // panel -> SW -> hope tabs
    HOPE_READING: "hopeReading",    // collapse -> SW (stored for the panel)
    TEST_CHIME: "testChime",        // onboarding -> SW
  },
  // Storage keys shared across contexts
  KEYS: {
    NOTIFY: ["chime", "notif", "badge"],
    SITES: "sites",
    USER_SITES: "userSites",
    LABELS: "labels",
    STARRED: "starred",
    STATS: "stats",
    SITE_STATS: "siteStats",  // lifetime per-host aggregates (analytics)
    RUN_LOG: "runLog",        // rolling per-run log (for CSV export)
    PANEL: "panel",
    COLLAPSE: "collapse",
  },
  // Hosts that ship built in (used to gate "watch current site")
  BUILTIN_RE: /(^|\.)(bit\.cloud|claude\.ai|gemini\.google\.com|chatgpt\.com|chat\.openai\.com|cursor\.com)$/i,
};
