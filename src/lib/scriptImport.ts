/**
 * Imports a script HTML page (the "Spoken script" format: <section class="beat"> blocks with an
 * <aside> label, plus optional "Production sheet" and "Sources" panels).
 *
 * Output: the spoken text (one paragraph per beat, so alignment keeps beat boundaries), the
 * beats as video sections, and per-product hints (model, official site, source links).
 */

export interface ScriptBeat {
  label: string;
  text: string;
  /** True when the beat is about a product (not a hook, intro or outro). */
  product: boolean;
}

export interface ScriptProduct {
  name: string;
  model?: string;
  officialSite?: string;
  links: string[];
}

export interface ImportedScript {
  title: string;
  beats: ScriptBeat[];
  products: ScriptProduct[];
}

const decode = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, " ")
    .trim();

const NON_PRODUCT = /^(hook|intro|introduction|opening|outro|ending|conclusion|wrap|cta|call to action|final|bonus|recap|summary|subscribe|like|comment|sponsor|disclaimer)\b/i;

export function parseScriptHtml(html: string): ImportedScript {
  const title = decode(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "");

  const beats: ScriptBeat[] = [];
  for (const m of html.matchAll(/<section[^>]*class=["'][^"']*\bbeat\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi)) {
    const block = m[1];
    const label = decode(block.match(/class=["']lab["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "");
    const paras = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((p) => decode(p[1])).filter(Boolean);
    if (paras.length) beats.push({ label, text: paras.join(" "), product: !!label && !NON_PRODUCT.test(label) });
  }
  if (!beats.length) {
    // Plain HTML: every paragraph of <main> (or <body>) is spoken text.
    const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
    for (const p of main.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      const text = decode(p[1]);
      if (text) beats.push({ label: "", text, product: false });
    }
  }

  // Production sheet: rows of <td>Product</td><td>Model to search</td><td>Official site</td>.
  const products: ScriptProduct[] = [];
  const sheet = html.match(/id=["']production["'][\s\S]*?<table[\s\S]*?<\/table>/i)?.[0] ?? "";
  for (const row of sheet.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 2) continue;
    const site = cells[2]?.match(/href=["']([^"']+)["']/i)?.[1] ?? (decode(cells[2] ?? "") || undefined);
    products.push({ name: decode(cells[0]), model: decode(cells[1]), officialSite: site, links: [] });
  }
  // No production sheet: product beats are the products.
  if (!products.length) for (const b of beats.filter((x) => x.product)) products.push({ name: b.label, links: [] });

  // Sources panel: attach each link to the product it mentions.
  const sources = html.match(/id=["']sources["'][\s\S]*?<\/ul>/i)?.[0] ?? "";
  for (const li of sources.matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
    const url = li[1].match(/href=["']([^"']+)["']/i)?.[1];
    if (!url) continue;
    const label = decode(li[1]).toLowerCase();
    const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    const best = products
      .map((p) => ({ p, hit: words(p.name).filter((w) => label.includes(w) || url.toLowerCase().includes(w)).length }))
      .sort((a, b) => b.hit - a.hit)[0];
    if (best && best.hit >= 2) best.p.links.push(url);
  }
  return { title, beats, products };
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** The product a beat is about: the one sharing the most words with the beat label. */
export function beatProduct(label: string, products: ScriptProduct[]): string | undefined {
  const lw = words(label);
  const best = products
    .map((p) => ({ name: p.name, hit: words(p.name).filter((w) => lw.includes(w)).length }))
    .sort((a, b) => b.hit - a.hit)[0];
  return best && best.hit >= 1 ? best.name : undefined;
}

export interface ScriptSection {
  label: string;
  kind: "intro" | "item" | "outro" | "body";
  product_name?: string;
}

/** Video sections in beat order (paragraph i of script.txt = section i). */
export function scriptSections(s: ImportedScript): ScriptSection[] {
  const firstProduct = s.beats.findIndex((b) => b.product);
  return s.beats.map((b, i) => {
    if (b.product) return { label: b.label, kind: "item" as const, product_name: beatProduct(b.label, s.products) ?? b.label };
    if (i < firstProduct || firstProduct < 0) return { label: b.label, kind: "intro" as const };
    return { label: b.label, kind: i === s.beats.length - 1 ? ("outro" as const) : ("body" as const) };
  });
}

/** Script text for alignment: one paragraph per beat (blank line between). */
export const scriptText = (s: ImportedScript) => s.beats.map((b) => b.text).join("\n\n") + "\n";
