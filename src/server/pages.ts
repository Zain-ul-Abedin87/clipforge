/**
 * The five tabs (web/full/full.js): Make (/), Ideas, My videos, Channel, Settings. A tab path serves
 * the page behind it; old addresses redirect so bookmarks keep working. The first app (the video
 * page + editor, footage / music library, channel look, general settings) lives at /app.
 */
export const TAB_PAGES: Record<string, string> = { "/": "home.html", "/ideas": "research.html", "/videos": "dashboard.html", "/channel": "brief.html", "/settings": "tools.html", "/app": "simple/index.html" };
export const OLD_PAGES: Record<string, string> = { "/research": "/ideas", "/dashboard": "/videos", "/brief": "/channel", "/tools": "/settings" };

/** A page request: the file to serve (relative to web/), a redirect, or null (not a tab page). */
export function resolvePage(pathname: string, search = ""): { file: string } | { redirect: string } | null {
  const p = pathname.replace(/\/$/, "") || "/";
  if (OLD_PAGES[p]) return { redirect: OLD_PAGES[p] + search };
  if (TAB_PAGES[p]) return { file: TAB_PAGES[p] };
  return null;
}
