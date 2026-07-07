// Sanity AI — onboarding page logic (external: MV3 CSP forbids inline scripts).
const btn = document.getElementById("chimeBtn");
if (btn) {
  btn.addEventListener("click", () => {
    try { chrome.runtime.sendMessage({ type: "testChime" }); } catch (e) {}
    btn.textContent = "That's the sound \u2713";
    btn.classList.add("played");
    setTimeout(() => { btn.textContent = "Play it again"; btn.classList.remove("played"); }, 2200);
  });
}
