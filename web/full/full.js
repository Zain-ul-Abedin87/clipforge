// Shared helpers for the full-pipeline pages (research, pipeline, dashboard, tools, chat).
// Plain browser JS, no build step. Every page includes <header id="top"></header>.

/**
 * The five tabs, in the order a creator thinks: what to make, ideas for it, the videos made, the
 * channel set up once, the settings. Every page (and the first app at /app) uses this header.
 */
export const TABS = [
  ["make", "/", "Make"],
  ["ideas", "/ideas", "Ideas"],
  ["videos", "/videos", "My videos"],
  ["channel", "/channel", "Channel"],
  ["settings", "/settings", "Settings"],
];
// Kept for older imports.
export const PAGES = TABS.map(([, href, label]) => [href, label]);

/** Which tab a page belongs to (paths and the first app's #/ routes). */
export function tabOf(pathname = location.pathname, hash = location.hash) {
  const p = pathname.replace(/\/$/, "") || "/";
  if (p === "/app") {
    const h = (hash || "").split("/")[1] || "";
    return h === "project" || h === "videos" ? "videos" : h === "library" || h === "look" ? "channel" : h === "settings" ? "settings" : "make";
  }
  if (p === "/ideas") return "ideas";
  if (p === "/videos" || p === "/pipeline") return "videos";
  if (p === "/channel") return "channel";
  if (p === "/settings") return "settings";
  if (p === "/chat") return "";
  return "make";
}

/** Sub-tabs of a tab (pages that belong together). */
export const SUBTABS = {
  channel: [["/channel", "Voice (brief)"], ["/app#/look", "Look & captions"], ["/app#/library", "Footage & music"], ["/channel#sops", "Competitor SOPs"]],
  settings: [["/app#/settings", "General & API keys"], ["/settings", "AI models & tools"]],
};

export function header() {
  const el = document.getElementById("top");
  if (!el) return;
  el.className = "top";
  const draw = () => {
    const here = tabOf();
    el.innerHTML = `<div class="top-in"><a class="brand" href="/"><span class="logo">C</span>ClipForge</a><nav>${TABS.map(
      ([id, href, label]) => `<a href="${href}" class="${id === here ? "active" : ""}">${label}</a>`,
    ).join("")}<a href="/chat" class="ask ${location.pathname === "/chat" ? "active" : ""}" title="Ask ClipForge to make something, step by step">Ask</a></nav></div>`;
  };
  draw();
  window.addEventListener("hashchange", draw);
}

/** Sub-tabs under a page title: `subnav("channel", el)`; the current one is marked. */
export function subnav(tab, el) {
  if (!el || !SUBTABS[tab]) return;
  const draw = () => {
    const here = location.pathname + location.hash;
    const cur = SUBTABS[tab].find(([href]) => href === here) || SUBTABS[tab].find(([href]) => href.split("#")[0] === location.pathname && !href.includes("#")) || SUBTABS[tab].find(([href]) => href === location.pathname + (location.hash || ""));
    el.className = "subnav";
    el.innerHTML = SUBTABS[tab].map(([href, label]) => `<a href="${href}" class="${cur && cur[0] === href ? "on" : ""}">${label}</a>`).join("");
  };
  draw();
  window.addEventListener("hashchange", draw);
}

export async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n ?? 0)));
export const secs = (ms) => (ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
export const ago = (t) => {
  const d = (Date.now() - t) / 1000;
  return d < 90 ? "just now" : d < 5400 ? `${Math.round(d / 60)} min ago` : d < 129600 ? `${Math.round(d / 3600)} h ago` : `${Math.round(d / 86400)} d ago`;
};
