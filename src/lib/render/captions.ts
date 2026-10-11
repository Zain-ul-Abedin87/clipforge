import type { AlignedWord } from "../../commands/align.js";

export interface CaptionStyle {
  enabled: boolean;
  font: string;
  fontSize: number;
  maxWordsPerLine: number;
  /** "rgba(0,0,0,0.55)" style string from style.json. */
  background: string;
  textColor: string;
  marginV: number;
}

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
}

/** Clean, minimal lines: at most N words, never across a sentence end, shown until the next line. */
export function captionLines(words: AlignedWord[], maxWords: number): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let cur: AlignedWord[] = [];
  const flush = () => {
    if (cur.length) lines.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.word).join(" ") });
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

export function buildAss(lines: CaptionLine[], st: CaptionStyle): string {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${st.font},${st.fontSize},${assColor(st.textColor)},${assColor(st.textColor)},${assColor(st.background)},${assColor(st.background)},-1,0,0,0,100,100,0,0,3,12,0,2,160,160,${st.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = lines.map((l) => `Dialogue: 0,${ts(l.start)},${ts(l.end)},Default,,0,0,0,,${assText(l.text)}`);
  return header + events.join("\n") + "\n";
}
