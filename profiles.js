// Sanity AI — detection profiles (data). The engine lives in content.js.
// To tune a site, edit here; to add a built-in site, add a profile AND a
// manifest content_scripts match. User-added sites use the "generic" profile.
(() => {
  // A "Stop"/"Cancel" control is the single most reliable cross-site cue:
  // it exists in the DOM only while the agent is generating.
  const STOP_CONTROLS = [
    'button[aria-label*="stop" i]',
    'button[aria-label*="cancel" i]',
    '[data-testid*="stop" i]',
  ];
  const SPINNERS = [
    '[class*="spinner" i]', '[class*="loading" i]',
    '[class*="streaming" i]', '[aria-busy="true"]', '[role="progressbar"]',
  ];

  // "Needs your input" — an agent paused mid-run waiting for approval.
  // Detected as a visible approve-ish button, corroborated by a reject-ish
  // sibling or an explicit test id (single "Run"/"Continue" buttons don't count).
  const APPROVE_RE = /^\s*(approve|allow(\s+(once|always|for this (chat|session)))?|accept|confirm|grant|authorize|apply|run (tool|command|it)|yes[,.!]?\s*(run|continue|proceed)?)\s*$/i;
  const REJECT_RE = /^\s*(reject|decline|deny|don'?t (allow|run)|not now|skip|dismiss|no[,.!]?)\s*$/i;
  const APPROVAL_TESTIDS = '[data-testid*="approve" i], [data-testid*="confirm" i], [data-testid*="permission" i], [data-testid*="tool-approval" i]';

  const PROFILES = [
    {
      name: "hope", label: "Hope AI",
      // Covers bit.cloud and its lanes/staging subdomains (main.lanes.bit.cloud …)
      test: (h, p) => /(^|\.)bit\.cloud$/i.test(h) && p.startsWith("/hope/session/"),
      settleMs: 2500, minActiveMs: 2000,
      useNetwork: true, domFallback: true, // POST api.v2.bit.cloud/hope/api/prompt (SSE) is primary; DOM is the safety net
      root: () => document.querySelector('[class*="conversation" i], [class*="messages" i], main') || document.body,
      // Hope-SPECIFIC run signals only. The generic SPINNERS latch here: Hope
      // leaves `hope-console_loading__` on finished message bubbles, and the
      // send button carries `generate`/`loading`-ish classes at idle — both are
      // permanent, so a generic [class*="loading"] never settles. Verified live:
      // during a run Hope shows a thinking indicator, a tool running-spinner,
      // and the send button flips to `bitcon-stop-alt2` (its stop control).
      indicatorSelectors: [
        '[class*="hope-console_thinkingIndicator" i]',
        '[class*="hope-console_thinkingStar" i]',
        '[class*="hope-console_thinkingLabel" i]',
        '[class*="tool-widget_runningSpinner" i]',
        '[class*="bitcon-stop-alt" i]', // send button becomes a stop control while generating
      ],
      textSignals: [/^\s*Thinking[\u2026.]{0,3}\s*$/],
      actionInProgress: (txt) =>
        /^Check\s*\d+\s*action/i.test(txt) && !/\d+\s*(?:ms|s|m)\s*$/.test(txt),
    },
    {
      name: "hope-idle", label: "Hope AI",
      // bit.cloud outside a session: DOM stays muted (no selectors — regular
      // site pages must produce zero noise), but the NETWORK signal is live:
      // Hope's widget can fire /hope/api/prompt from ANY bit.cloud page, and
      // that submit must count as a run from second zero. Follows the same
      // settings toggle as "hope".
      test: (h) => /(^|\.)bit\.cloud$/i.test(h),
      settings: "hope",
      settleMs: 2500, minActiveMs: 2000,
      useNetwork: true, // network-only: no domFallback, empty indicators
      root: () => document.body,
      indicatorSelectors: [], textSignals: [], actionInProgress: null,
    },
    {
      name: "claude-code", label: "Claude Code",
      // claude.ai/code — Claude Code on the web. Long agentic runs (Fable &co)
      // whose API is NOT the chat completion endpoint, so the network hook
      // stays silent and the DOM carries detection alone. Agentic pacing:
      // a longer quiet window so tool handoffs don't read as completions.
      test: (h, p) => h === "claude.ai" && p.startsWith("/code"),
      settings: "claude", // same on/off switch as Claude
      settleMs: 4000, minActiveMs: 3000,
      root: () => document.querySelector("main") || document.body,
      indicatorSelectors: [...STOP_CONTROLS, '[class*="streaming" i]', '[data-is-streaming="true"]'],
      textSignals: [],
      actionInProgress: null,
    },
    {
      name: "claude", label: "Claude",
      test: (h) => h === "claude.ai",
      settleMs: 2500, minActiveMs: 2000,
      useNetwork: true, domFallback: true, // network is primary; DOM stays as a safety net
      root: () => document.querySelector("main") || document.body,
      indicatorSelectors: [...STOP_CONTROLS, '[class*="streaming" i]', '[data-is-streaming="true"]'],
      textSignals: [],
      actionInProgress: null,
    },
    {
      name: "gemini", label: "Gemini",
      test: (h) => h === "gemini.google.com",
      settleMs: 2500, minActiveMs: 2000,
      useNetwork: true, // DOM updates are deferred while backgrounded; watch the request instead
      root: () => document.querySelector("main") || document.body,
      indicatorSelectors: [...STOP_CONTROLS, 'mat-progress-bar', '[class*="loading" i]'],
      textSignals: [],
      actionInProgress: null,
    },
    {
      name: "chatgpt", label: "ChatGPT",
      test: (h) => h === "chatgpt.com" || h === "chat.openai.com",
      settleMs: 2500, minActiveMs: 2000,
      useNetwork: true, domFallback: true,
      root: () => document.querySelector("main") || document.body,
      indicatorSelectors: [
        '[class*="result-streaming" i]',
        'button[data-testid="stop-button"]',
        ...STOP_CONTROLS,
      ],
      textSignals: [],
      actionInProgress: null,
    },
    {
      name: "cursor", label: "Cursor",
      // Cursor is primarily a desktop app; this covers any in-browser surface.
      test: (h) => h === "cursor.com" || h === "www.cursor.com",
      root: () => document.querySelector("main") || document.body,
      indicatorSelectors: [...STOP_CONTROLS, ...SPINNERS, '[class*="generating" i]'],
      textSignals: [/^\s*(Generating|Thinking|Working)[\u2026.]{0,3}\s*$/i],
      actionInProgress: null,
    },
    {
      name: "perplexity", label: "Perplexity",
      // Built in (Dia can't grant new sites at runtime); scored like generic
      // so a stray page spinner alone doesn't read as "agent working".
      test: (h) => h === "perplexity.ai" || h === "www.perplexity.ai",
      scored: true,
      root: () => document.querySelector("main") || document.body,
      indicatorSelectors: [...STOP_CONTROLS, ...SPINNERS, '[class*="thinking" i]'],
      textSignals: [/^\s*(Thinking|Generating|Working|Running|Researching)[\u2026.]{0,3}\s*$/i],
      actionInProgress: null,
    },
    {
      name: "generic", label: "Other",
      test: () => true,
      // User-added sites: require corroboration (scored detection in content.js)
      // so a stray page spinner alone doesn't read as "agent working".
      scored: true,
      root: () => document.querySelector("main") || document.body,
      indicatorSelectors: [...STOP_CONTROLS, ...SPINNERS, '[class*="thinking" i]'],
      textSignals: [/^\s*(Thinking|Generating|Working|Running)[\u2026.]{0,3}\s*$/i],
      actionInProgress: null,
    },
  ];

  // Isolated-world global consumed by content.js.
  window.SANITY_DETECT = { STOP_CONTROLS, SPINNERS, PROFILES, APPROVE_RE, REJECT_RE, APPROVAL_TESTIDS };
})();
