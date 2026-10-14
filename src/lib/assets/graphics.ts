import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import type { Graphic } from "../scenes.js";
import { ffmpegPath } from "../tools.js";

export interface CardStyle {
  primary: string;
  secondary: string;
  text: string;
  accent: string;
  titleFont?: string;
  bodyFont?: string;
}

const W = 1920;
const H = 1080;

/** Font lookup: project assets/fonts first (e.g. Oswald-Bold.ttf), then Windows fallbacks. */
function font(name: string | undefined, bold: boolean): string {
  const dir = path.join(paths.root, "assets", "fonts");
  if (name && fs.existsSync(dir)) {
    const want = name.toLowerCase().replace(/\s+/g, "");
    const files = fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f) && f.toLowerCase().replace(/[\s-_]/g, "").startsWith(want));
    const pick = files.find((f) => /bold|black|heavy/i.test(f) === bold) ?? files[0];
    if (pick) return path.join(dir, pick);
  }
  const win = "C:/Windows/Fonts";
  for (const f of bold ? ["arialbd.ttf", "segoeuib.ttf"] : ["arial.ttf", "segoeui.ttf"]) {
    if (fs.existsSync(path.join(win, f))) return `${win}/${f}`;
  }
  return `${win}/arial.ttf`;
}

/** FFmpeg filter-arg escaping for a path: forward slashes, escaped drive colon. */
const fpath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
const color = (hex: string) => `0x${hex.replace("#", "")}`;

/** Greedy word wrap using an average glyph width estimate (no font metrics available). */
function wrap(text: string, fontSize: number, maxWidth: number, maxLines = 3): string {
  const perLine = Math.max(6, Math.floor(maxWidth / (fontSize * 0.56)));
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if ((cur + " " + word).trim().length > perLine && cur) {
      lines.push(cur);
      cur = word;
    } else cur = (cur + " " + word).trim();
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  }
  return lines.join("\n");
}

interface Text {
  text: string;
  size: number;
  font: string;
  color: string;
  x: string;
  y: string;
  box?: string;
}

interface CardOpts {
  /** Transparent canvas (an animation layer) instead of the coloured card background. */
  transparent?: boolean;
  /** Accent bars on the card edge (background only). */
  bars?: boolean;
  /**
   * A semi-transparent panel (lower-third bar, badge box). drawbox cannot write alpha onto a
   * transparent canvas, so the panel is its own canvas with an alpha level, padded to full frame.
   */
  panel?: { x: number; y: number; w: number; h: number; opacity: number; strips?: { x: number; w: number; color: string }[] };
}

/**
 * Renders a card or a transparent text layer to PNG with FFmpeg drawtext. Text goes through
 * textfile= so no escaping of user text is needed; output is cached by content hash.
 */
async function renderCard(texts: Text[], bg: string, accent: string, outDir: string, opts: CardOpts = { bars: true }): Promise<string> {
  const key = crypto.createHash("sha1").update(JSON.stringify({ texts, bg, accent, opts, v: 3 })).digest("hex").slice(0, 16);
  const out = path.join(outDir, `${opts.transparent ? "layer" : "card"}_${key}.png`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(outDir, { recursive: true });

  const tmp = path.join(outDir, `.txt_${key}`);
  fs.mkdirSync(tmp, { recursive: true });
  const filters: string[] = [];
  if (opts.bars) {
    // Accent bar on the left edge and a thin band at the bottom.
    filters.push(`drawbox=x=0:y=0:w=28:h=ih:color=${color(accent)}:t=fill`, `drawbox=x=0:y=ih-8:w=iw:h=8:color=${color(accent)}@0.5:t=fill`);
  }

  texts.forEach((t, i) => {
    const tf = path.join(tmp, `${i}.txt`);
    fs.writeFileSync(tf, t.text, "utf8");
    filters.push(
      `drawtext=fontfile='${fpath(t.font)}':textfile='${fpath(tf)}':fontsize=${t.size}:fontcolor=${t.color}` +
        `:x=${t.x}:y=${t.y}:line_spacing=${Math.round(t.size * 0.18)}` +
        (t.box ? `:box=1:boxcolor=${t.box}:boxborderw=${Math.round(t.size * 0.25)}` : ""),
    );
  });
  if (!filters.length) filters.push("null");

  const ff = ffmpegPath();
  if (!ff) throw new Error("ffmpeg not found");
  let source = opts.transparent ? `color=c=black@0.0:s=${W}x${H},format=rgba` : `color=c=${color(bg)}:s=${W}x${H}`;
  if (opts.panel) {
    const p = opts.panel;
    const strips = (p.strips ?? []).map((st) => `drawbox=x=${st.x}:y=0:w=${st.w}:h=${p.h}:color=${st.color}:t=fill`);
    source = [
      `color=c=black:s=${p.w}x${p.h}`,
      "format=rgba",
      ...strips,
      `colorchannelmixer=aa=${p.opacity}`,
      `pad=${W}:${H}:${p.x}:${p.y}:color=black@0.0`,
    ].join(",");
  }
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", source, "-vf", filters.join(","), "-frames:v", "1", out]);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.code !== 0) throw new Error(`card render failed: ${r.stderr.slice(-400)}`);
  return out;
}

/**
 * A card's text, grouped by what animates together (e.g. a "+" marker and its line). The static
 * card is all groups flattened; the animated card shows the groups one after another.
 */
function cardGroups(g: Graphic, style: CardStyle): Text[][] {
  const bold = font(style.titleFont, true);
  const body = font(style.bodyFont, false);
  const white = color(style.text);
  const acc = color(style.primary);
  const grey = "0x9a9a9a";
  const center = "(w-text_w)/2";

  switch (g.kind) {
    case "title_card":
      if (g.rank === undefined) {
        return [
          [{ text: "UP NEXT", size: 60, font: bold, color: acc, x: center, y: "360" }],
          [{ text: wrap(g.title.toUpperCase(), 130, 1600, 2), size: 130, font: bold, color: white, x: center, y: "450" }],
        ];
      }
      return [
        [{ text: "NUMBER", size: 54, font: bold, color: grey, x: center, y: "250" }],
        [{ text: String(g.rank ?? ""), size: 330, font: bold, color: acc, x: center, y: "300" }],
        [{ text: wrap(g.title.toUpperCase(), 110, 1500, 2), size: 110, font: bold, color: white, x: center, y: "690" }],
      ];
    case "price_badge":
      return [
        [{ text: wrap(g.title, 90, 1500, 2), size: 90, font: bold, color: white, x: center, y: "300" }],
        [{ text: g.price ?? "", size: 200, font: bold, color: color(style.secondary), x: center, y: "560", box: `${acc}` }],
      ];
    case "intro_card":
    case "end_card":
      return [
        [{ text: g.kind === "intro_card" ? "TODAY'S COUNTDOWN" : "SEE YOU NEXT TIME", size: 50, font: bold, color: acc, x: center, y: "380" }],
        [{ text: wrap(g.title.toUpperCase(), 120, 1600, 2), size: 120, font: bold, color: white, x: center, y: "470" }],
      ];
    default: {
      // spec_card / pros_cons: label + title, then up to 4 lines with coloured +/- markers.
      const groups: Text[][] = [
        [
          { text: g.kind.replace("_", " ").toUpperCase(), size: 44, font: bold, color: acc, x: "200", y: "190" },
          { text: wrap(g.title, 96, 1500, 1), size: 96, font: bold, color: white, x: "200", y: "250" },
        ],
      ];
      (g.lines ?? []).slice(0, 4).forEach((l, i) => {
        const y = 440 + i * 130;
        const mark = l.startsWith("+") ? "+" : l.startsWith("-") ? "–" : "•";
        const markColor = mark === "+" ? "0x4caf7a" : mark === "–" ? "0xe2574c" : acc;
        groups.push([
          { text: mark, size: 70, font: bold, color: markColor, x: "200", y: String(y) },
          { text: wrap(l.replace(/^[+-]\s*/, ""), 66, 1400, 1), size: 66, font: body, color: white, x: "280", y: String(y + 4) },
        ]);
      });
      return groups;
    }
  }
}

/** Code-generated graphic for a scene (title card, price badge, spec card, ...), as one still. */
export async function renderGraphic(g: Graphic, style: CardStyle, outDir: string): Promise<string> {
  return renderCard(cardGroups(g, style).flat(), style.secondary, style.primary, outDir);
}

export interface Layer {
  path: string;
  /** Seconds after the scene starts. */
  delay: number;
  anim: "slide_up" | "slide_left" | "slide_right" | "fade";
  /** Seconds after the scene starts to fade the layer out (omit to keep it). */
  out?: number;
  /** path is a video with alpha (Remotion card, ProRes 4444) that animates itself. */
  video?: boolean;
  /** Remotion card to render instead of this PNG (cards/); the PNG stays as the fallback. */
  card?: { comp: "RankCard" | "PriceCard" | "SpecCard" | "LowerThird" | "SpecBars" | "ProsCons" | "PriceTag" | "CompareTable"; props: Record<string, unknown>; seconds?: number };
}

/** The same card as an empty background plus one transparent layer per text group. */
export async function renderCardLayers(g: Graphic, style: CardStyle, outDir: string): Promise<{ background: string; layers: Layer[] }> {
  const background = await renderCard([], style.secondary, style.primary, outDir);
  const groups = cardGroups(g, style);
  const layers: Layer[] = [];
  for (const [i, group] of groups.entries()) {
    const file = await renderCard(group, style.secondary, style.primary, outDir, { transparent: true });
    // Title cards reveal fast (the voice says the name right away); lists step through their lines.
    const step = g.kind === "title_card" ? 0.18 : g.kind === "spec_card" || g.kind === "pros_cons" ? 0.45 : 0.3;
    layers.push({ path: file, delay: Math.round((0.1 + i * step) * 100) / 100, anim: "slide_up" });
  }
  return { background, layers };
}

/** Bottom-left name strip over product footage: "#5 | SIG SAUER P365". */
export async function renderLowerThird(rank: number | undefined, name: string, style: CardStyle, outDir: string): Promise<string> {
  const bold = font(style.titleFont, true);
  const label = name.toUpperCase();
  const size = 54;
  const badge = rank !== undefined ? 130 : 0;
  const width = Math.min(1500, Math.round(label.length * size * 0.62) + 90 + badge);
  const y = 840;
  const panel = {
    x: 0, y, w: width, h: 110, opacity: 0.82,
    strips: [{ x: 0, w: rank !== undefined ? badge : 12, color: color(style.primary) }],
  };
  const texts: Text[] = [{ text: label, size, font: bold, color: color(style.text), x: String(badge + 40), y: String(y + 28) }];
  if (rank !== undefined) texts.push({ text: `#${rank}`, size: 62, font: bold, color: color(style.secondary), x: "34", y: String(y + 22) });
  return renderCard(texts, style.secondary, style.primary, outDir, { transparent: true, panel });
}

/** Small corner badge ("#3") shown through a product's section. */
export async function renderRankBadge(rank: number, style: CardStyle, outDir: string): Promise<string> {
  const bold = font(style.titleFont, true);
  const panel = { x: 60, y: 50, w: 150, h: 90, opacity: 0.7, strips: [{ x: 0, w: 8, color: color(style.primary) }] };
  return renderCard([{ text: `#${rank}`, size: 64, font: bold, color: color(style.primary), x: "92", y: "62" }], style.secondary, style.primary, outDir, {
    transparent: true,
    panel,
  });
}

/**
 * Spec callout on the right side of a product shot ("9MM LUGER", "$389 MSRP"), one chip per fact,
 * stacked from `index`; each chip is its own layer so they can slide in one after another.
 */
export async function renderSpecChip(text: string, index: number, style: CardStyle, outDir: string): Promise<string> {
  const bold = font(style.titleFont, true);
  const label = text.toUpperCase();
  const size = label.length > 20 ? 36 : 42;
  const w = Math.min(700, Math.round(label.length * size * 0.6) + 80);
  const h = 84;
  const x = W - w - 70;
  const y = 250 + index * 108;
  const panel = { x, y, w, h, opacity: 0.84, strips: [{ x: w - 10, w: 10, color: color(style.primary) }] };
  return renderCard([{ text: label, size, font: bold, color: color(style.text), x: String(x + 34), y: String(y + Math.round((h - size) / 2) - 1) }], style.secondary, style.primary, outDir, {
    transparent: true,
    panel,
  });
}

/**
 * Info panel on the right of a product photo, replacing the full-screen black card: a small
 * kicker ("UP NEXT", "PRICE"), the product name, and optionally a big value in an accent box.
 */
export async function renderSidePanel(kicker: string, title: string, big: string | undefined, style: CardStyle, outDir: string): Promise<string> {
  const bold = font(style.titleFont, true);
  const w = 680;
  const h = big ? 400 : 290;
  const x = W - w - 80;
  const y = Math.round((H - h) / 2) - 40;
  const panel = { x, y, w, h, opacity: 0.86, strips: [{ x: 0, w: 12, color: color(style.primary) }] };
  const texts: Text[] = [
    { text: kicker.toUpperCase(), size: 40, font: bold, color: color(style.primary), x: String(x + 56), y: String(y + 44) },
    { text: wrap(title.toUpperCase(), 64, w - 100, 2), size: 64, font: bold, color: color(style.text), x: String(x + 56), y: String(y + 104) },
  ];
  if (big) texts.push({ text: big, size: 96, font: bold, color: color(style.secondary), x: String(x + 56), y: String(y + 250), box: color(style.primary) });
  return renderCard(texts, style.secondary, style.primary, outDir, { transparent: true, panel });
}

/** Fallback card when no footage exists: the product name or the scene's key phrase. */
export async function renderTextCard(kicker: string, title: string, style: CardStyle, outDir: string): Promise<string> {
  const bold = font(style.titleFont, true);
  return renderCard(
    [
      { text: kicker.toUpperCase(), size: 46, font: bold, color: color(style.primary), x: "(w-text_w)/2", y: "400" },
      { text: wrap(title, 110, 1600, 2), size: 110, font: bold, color: color(style.text), x: "(w-text_w)/2", y: "480" },
    ],
    "#1b1d21", style.primary, outDir,
  );
}
