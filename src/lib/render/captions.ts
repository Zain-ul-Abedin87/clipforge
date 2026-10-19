import type { AlignedWord } from "../../commands/align.js";
import { captionPreset, CaptionPreset } from "./captionPresets.js";

export interface CaptionStyle {
  enabled: boolean;
  font: string;
  fontSize: number;
  maxWordsPerLine: number;
  /** "rgba(0,0,0,0.55)" style string from style.json. */
  background: string;
  textColor: string;
  marginV: number;
  /** Named style (captionPresets.ts); missing = "classic". */
  preset?: string;
}

/** The look of a channel without caption settings (the values timeline.ts falls back to). */
export const DEFAULT_CAPTION_STYLE: Omit<CaptionStyle, "enabled"> = { font: "Arial", fontSize: 54, maxWordsPerLine: 7, background: "rgba(0,0,0,0.55)", textColor: "#FFFFFF", marginV: 70 };

/** ASS colours are &HAABBGGRR with inverted alpha (00 = opaque). */
function assColor(css: string, fallbackAlpha = 0): string {
  const rgba = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i);
  let r = 0, g = 0, b = 0, a = 1 - fallbackAlpha;
  if (rgba) {
    [r, g, b] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
    if (rgba[4] !== undefined) a = Number(rgba[4]);
  } else {
    const hex = css.replace("#", "");
    if (hex.length >= 6) [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }
  const hx = (n: number) => Math.round(n).toString(16).padStart(2, "0").toUpperCase();
  return `&H${hx((1 - a) * 255)}${hx(b)}${hx(g)}${hx(r)}`;
}

const ts = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

const assText = (s: string) => s.replace(/\\/g, "\\\\").replace(/[{}]/g, "").replace(/\n/g, " ");

export interface CaptionLine {
  start: number;
  end: number;
  text: string;
  /** Per-word timing, only when the style needs it (karaoke / word). */
  words?: { text: string; start: number; end: number }[];
}

/** Clean, minimal lines: at most N words, never across a sentence end, shown until the next line. */
export function captionLines(words: AlignedWord[], maxWords: number, opts: { withWords?: boolean } = {}): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let cur: AlignedWord[] = [];
  const flush = () => {
    if (cur.length) {
      lines.push({
        start: cur[0].start,
        end: cur[cur.length - 1].end,
        text: cur.map((w) => w.word).join(" "),
        ...(opts.withWords ? { words: cur.map((w) => ({ text: w.word, start: w.start, end: w.end })) } : {}),
      });
    }
    cur = [];
  };
  for (const w of words) {
    if (w.source === "extra") continue;
    cur.push(w);
    if (cur.length >= maxWords || /[.!?]["')\]]*$/.test(w.word)) flush();
  }
  flush();
  // Hold each line until the next starts (max +0.6 s), so captions do not flicker between lines.
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1]?.start ?? Infinity;
    lines[i].end = Math.min(next - 0.02, lines[i].end + 0.6);
  }
  return lines;
}

const cs = (seconds: number) => Math.max(1, Math.round(seconds * 100));
const casing = (p: CaptionPreset, text: string) => (p.uppercase ? text.toUpperCase() : text);

/** The one ASS style of a preset. Classic keeps the channel's box exactly as it always was. */
function styleLine(st: CaptionStyle, p: CaptionPreset): string {
  const size = Math.round(st.fontSize * p.sizeScale);
  const text = assColor(p.textColor ?? st.textColor);
  const fields = (primary: string, secondary: string, outline: string, back: string, borderStyle: number, outlineWidth: number, shadow: number) =>
    `Style: Default,${st.font},${size},${primary},${secondary},${outline},${back},-1,0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadow},2,160,160,${st.marginV},1`;
  if (p.box) return fields(text, text, assColor(st.background), assColor(st.background), 3, 12, 0);
  // Karaoke sweeps from the secondary to the primary colour; Pop draws every word in the accent colour.
  const primary = p.mode === "line" ? text : assColor(p.accent);
  return fields(primary, text, assColor(p.outlineColor), "&H80000000", 1, p.outline, p.shadow);
}

function assEvents(lines: CaptionLine[], p: CaptionPreset): string[] {
  const dialogue = (start: number, end: number, text: string) => `Dialogue: 0,${ts(start)},${ts(end)},Default,,0,0,0,,${text}`;
  return lines.map((l) => {
    if (p.mode === "karaoke" && l.words?.length) {
      // \kf = a fill sweep of that many centiseconds; each word lasts until the next one starts.
      const text = l.words.map((w, i) => `{\\kf${cs((l.words![i + 1]?.start ?? w.end) - w.start)}}${assText(casing(p, w.text))}`).join(" ");
      return dialogue(l.start, l.end, text);
    }
    if (p.mode === "word") return dialogue(l.start, l.end, `{\\fscx75\\fscy75\\t(0,120,\\fscx100\\fscy100)}${assText(casing(p, l.text))}`);
    return dialogue(l.start, l.end, assText(casing(p, l.text)));
  });
}

export function buildAss(lines: CaptionLine[], st: CaptionStyle): string {
  const p = captionPreset(st.preset);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styleLine(st, p)}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  return header + assEvents(lines, p).join("\n") + "\n";
}

/** Aligned words (voice-file time) -> timeline time after editor cuts; words in a cut part are dropped. */
export function remapWords<W extends { start: number; end: number }>(words: W[], parts?: { in: number; dur: number }[]): W[] {
  if (!parts?.length) return words;
  const out: W[] = [];
  for (const w of words) {
    let at = 0;
    for (const p of parts) {
      if (w.start >= p.in - 1e-6 && w.start < p.in + p.dur) {
        const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
        out.push({ ...w, start: r6(at + (w.start - p.in)), end: r6(at + Math.min(w.end, p.in + p.dur) - p.in) });
        break;
      }
      at += p.dur;
    }
  }
  return out;
}
