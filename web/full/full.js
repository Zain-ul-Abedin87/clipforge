// Shared helpers for the full-pipeline pages (research, pipeline, dashboard, tools, chat).
// Plain browser JS, no build step. Every page includes <header id="top"></header>.

export const PAGES = [
  ["/new", "New video"],
  ["/research", "Research"],
  ["/pipeline", "Pipeline"],
  ["/dashboard", "Dashboard"],
  ["/brief", "Channel"],
  ["/tools", "Tools"],
  ["/chat", "Chat"],
  ["/", "Classic"],
];

export function header() {
  const el = document.getElementById("top");
  if (!el) return;
  const here = location.pathname.replace(/\/$/, "") || "/";
  el.className = "top";
  el.innerHTML = `<div class="top-in"><a class="brand" href="/"><span class="logo">C</span>ClipForge</a><nav>${PAGES.map(
    ([href, label]) => `<a href="${href}" class="${href === here ? "active" : ""}">${label}</a>`,
  ).join("")}</nav></div>`;
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
