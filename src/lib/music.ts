import fs from "node:fs";
import path from "node:path";

/**
 * Background music: the channel's track library (channels/<channel>/music) and the per-video choice.
 *
 * A video picks its music in the Create page (stored in project.json as `music`):
 *   default  follow the channel (style.json music.enabled; every library track as a playlist)
 *   off      no music for this video
 *   track    exactly one library track, whatever the channel default says
 * Fine adjustments (level, ducking, fades, another track) are then made in the studio on the
 * timeline's music clip.
 */

export const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".ogg", ".flac"] as const;
export const isAudioFile = (name: string) => (AUDIO_EXTENSIONS as readonly string[]).includes(path.extname(name).toLowerCase());

export const DEFAULT_MUSIC_DB = -18;
/** Allowed music level (dB, before ducking) and fade length (s). */
export const MUSIC_DB_RANGE = { min: -50, max: 0 } as const;
export const FADE_RANGE_SEC = { min: 0, max: 10 } as const;

export interface MusicChoice {
  mode: "default" | "off" | "track";
  /** Library file name (mode "track"). */
  track?: string;
  volumeDb?: number;
  duck?: boolean;
}

export interface ResolvedMusic {
  files: string[];
  volumeDb: number;
  duck: boolean;
  /** One line for the step log / QA ("track mood.mp3", "off (channel default)"). */
  note: string;
}

const inRange = (v: unknown, r: { min: number; max: number }): v is number => typeof v === "number" && Number.isFinite(v) && v >= r.min && v <= r.max;

/** Validates a client-supplied choice; anything unknown falls back to "default". */
export function parseMusicChoice(raw: unknown): MusicChoice {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode = r.mode === "off" || r.mode === "track" ? r.mode : "default";
  const track = typeof r.track === "string" && r.track && path.basename(r.track) === r.track && isAudioFile(r.track) ? r.track : undefined;
  return {
    mode: mode === "track" && !track ? "default" : mode,
    ...(mode === "track" && track ? { track } : {}),
    ...(inRange(r.volumeDb, MUSIC_DB_RANGE) ? { volumeDb: r.volumeDb } : {}),
    ...(typeof r.duck === "boolean" ? { duck: r.duck } : {}),
  };
}

type StyleLike = Record<string, unknown>;
const musicCfg = (style: StyleLike) => (style.music ?? {}) as { volumeDb?: unknown; folder?: unknown };

export const libraryDir = (channelDir: string, style: StyleLike = {}) => path.join(channelDir, typeof musicCfg(style).folder === "string" ? String(musicCfg(style).folder) : "music");

export function libraryTracks(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(isAudioFile).sort() : [];
}

/** Absolute path of a library track, or null (also for names that try to leave the folder). */
export function trackPath(dir: string, name: string): string | null {
  if (!name || path.basename(name) !== name || !isAudioFile(name)) return null;
  const file = path.join(dir, name);
  return fs.existsSync(file) ? file : null;
}

/** Licence note recorded at upload (music/sources.json), "" when the file was copied in by hand. */
export function trackLicense(dir: string, name: string): string {
  const src = path.join(dir, "sources.json");
  if (!fs.existsSync(src)) return "";
  try {
    return String((JSON.parse(fs.readFileSync(src, "utf8")) as Record<string, { license?: string }>)[name]?.license ?? "").trim();
  } catch {
    return "";
  }
}

export function resolveMusic(i: { style: StyleLike; defaultEnabled: boolean; choice: MusicChoice; channelDir: string }): ResolvedMusic {
  const dir = libraryDir(i.channelDir, i.style);
  const cfgDb = musicCfg(i.style).volumeDb;
  const volumeDb = i.choice.volumeDb ?? (typeof cfgDb === "number" ? cfgDb : DEFAULT_MUSIC_DB);
  const duck = i.choice.duck ?? true;
  const none = (note: string): ResolvedMusic => ({ files: [], volumeDb, duck, note });
  if (i.choice.mode === "off") return none("off (chosen for this video)");
  if (i.choice.mode === "track") {
    const file = trackPath(dir, i.choice.track ?? "");
    return file ? { files: [file], volumeDb, duck, note: `track ${i.choice.track}` } : none(`track "${i.choice.track}" is not in the channel library - no music`);
  }
  if (!i.defaultEnabled) return none("off (channel default: style.json music.enabled)");
  const files = libraryTracks(dir).map((f) => path.join(dir, f));
  return files.length ? { files, volumeDb, duck, note: `channel library (${files.length} track${files.length === 1 ? "" : "s"})` } : none("none (the channel library is empty)");
}
