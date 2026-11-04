import fs from "node:fs";
import path from "node:path";
import { run } from "../exec.js";
import { ffmpegPath } from "../tools.js";
import { captionFontsDir } from "../fonts.js";
import { captionLines, highlightEvents } from "../render/captions.js";
import { captionPreset } from "../render/captionPresets.js";
import type { ShortWindow } from "./pick.js";
import { DIMS, Reframe, reframeFilter, ShortFormat } from "./reframe.js";

/**
 * Shorts render: a 1080x1920 (9:16) cut of the finished video. The 16:9 picture sits in the middle
 * at full width over a blurred, zoomed copy of itself, with big word-highlight captions in the
 * upper-middle (clear of the Shorts UI at the bottom). Always under 60 s.
 */

export interface Word {
  word: string;
  start: number;
  end: number;
}

const ts = (t: number) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, "0")}:${String(Math.floor((cs % 6000) / 100)).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** Caption placement per shape: upper-middle on 9:16 (clear of the Shorts UI), lower third elsewhere. */
const CAPTION_PLACE: Record<ShortFormat, { size: number; align: number; marginV: number }> = { "9:16": { size: 92, align: 8, marginV: 330 }, "1:1": { size: 72, align: 2, marginV: 120 }, "16:9": { size: 64, align: 2, marginV: 80 } };

/** ASS captions (PlayRes = the Short's size): word highlight, 3 words per line, times relative to the Short. */
export function shortAss(words: Word[], win: { start: number; end: number }, presetId = "bold-pop", format: ShortFormat = "9:16"): string {
  const p = captionPreset(presetId);
  const inWin = words.filter((w) => w.start >= win.start - 0.05 && w.start < win.end).map((w) => ({ ...w, start: w.start - win.start, end: Math.min(w.end, win.end) - win.start, source: "script" as const }));
  const lines = captionLines(inWin, 3, { withWords: true });
  const hp = p.mode === "highlight" ? p : captionPreset("bold-pop");
  const events = lines.flatMap((l) => highlightEvents(l, hp)).map((e) => `Dialogue: 0,${ts(e.start)},${ts(e.end)},Short,,0,0,0,,${e.text}`);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${DIMS[format].W}
PlayResY: ${DIMS[format].H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Short,Inter,${CAPTION_PLACE[format].size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,8,3,${CAPTION_PLACE[format].align},60,60,${CAPTION_PLACE[format].marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

/** Same escaping as the main render's subtitles filter (Windows drive colon, quotes). */
const fpath = (f: string) => f.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

export function shortFilter(assFile: string | null, frame?: { format: ShortFormat; reframe: Reframe; srcW: number; srcH: number; keys: { t: number; x: number }[] | null }): string {
  const base = frame
    ? reframeFilter(frame.format, frame.reframe, frame.srcW, frame.srcH, frame.keys).replace(/\[vbase\]$/, "")
    : "[0:v]split=2[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=28:3,eq=brightness=-0.15[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=x=0:y=(H-h)/2,setsar=1,fps=30";
  return assFile ? `${base},subtitles='${fpath(assFile)}':fontsdir='${fpath(captionFontsDir())}'[v]` : `${base}[v]`;
}

export async function renderShort(video: string, win: Pick<ShortWindow, "start" | "end">, words: Word[], out: string, o: { captions: boolean; preset?: string; maxSec?: number; frame?: { format: ShortFormat; reframe: Reframe; srcW: number; srcH: number; keys: { t: number; x: number }[] | null } }): Promise<{ file: string; seconds: number }> {
  const ff = ffmpegPath();
  if (!ff) throw new Error("ffmpeg not found");
  const dur = Math.min(win.end - win.start, o.maxSec ?? 59);
  let ass: string | null = null;
  if (o.captions) {
    ass = out.replace(/\.mp4$/i, ".ass");
    fs.writeFileSync(ass, shortAss(words, { start: win.start, end: win.start + dur }, o.preset, o.frame?.format ?? "9:16"), "utf8");
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-ss", win.start.toFixed(3), "-t", dur.toFixed(3), "-i", video, "-filter_complex", shortFilter(ass, o.frame), "-map", "[v]", "-map", "0:a:0?", "-c:v", "libx264", "-preset", process.env.SHORTS_X264_PRESET || "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out]);
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`Short render failed: ${r.stderr.slice(-300)}`);
  return { file: out, seconds: dur };
}
