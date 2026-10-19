import fs from "node:fs";
import path from "node:path";
import { env } from "./env.js";
import { paths } from "./paths.js";

/**
 * Fonts for everything FFmpeg draws (drawtext cards, burned-in captions, template diagrams). Only
 * bundled files are used, so a render looks the same on Windows, Linux and in Docker and never
 * depends on what the machine has installed:
 *   assets/fonts         Inter Regular / Bold (OFL, licenses/OFL-Inter.txt) and any fonts you add
 *   cards/public/fonts   Anton (OFL), also used by the Remotion cards
 *   FONTS_DIR            optional extra folder
 * A requested family that is not there falls back to Anton for condensed display faces (Oswald,
 * Bebas...) and to Inter otherwise.
 */

const DISPLAY_RE = /oswald|anton|bebas|league\s*gothic|impact|condensed|compressed/i;
const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");

export const userFontDir = () => path.join(paths.root, "assets", "fonts");
export const fontDirs = (): string[] => [userFontDir(), path.join(paths.root, "cards", "public", "fonts"), env("FONTS_DIR")].filter((d) => !!d && fs.existsSync(d));

export const BUNDLED = {
  regular: () => path.join(userFontDir(), "Inter-Regular.ttf"),
  bold: () => path.join(userFontDir(), "Inter-Bold.ttf"),
  display: () => path.join(paths.root, "cards", "public", "fonts", "Anton-Regular.ttf"),
};

/** A font file whose name starts with `name` ("Oswald" -> Oswald-Bold.ttf), bold preferred when asked. */
export function fontFileFor(name: string, bold: boolean): string | undefined {
  const want = norm(name);
  for (const dir of fontDirs()) {
    const files = fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f) && norm(f).startsWith(want));
    const pick = files.find((f) => /bold|black|heavy/i.test(f) === bold) ?? files[0];
    if (pick) return path.join(dir, pick);
  }
  return undefined;
}

/** Absolute path of a font file for `name`; always a file that exists (bundled fallback). */
export function findFont(name: string | undefined, bold: boolean): string {
  const hit = name ? fontFileFor(name, bold) : undefined;
  if (hit) return hit;
  if (name && DISPLAY_RE.test(name)) return BUNDLED.display();
  return bold ? BUNDLED.bold() : BUNDLED.regular();
}

/** Folder libass reads caption fonts from (subtitles filter `fontsdir`). */
export const captionFontsDir = () => userFontDir();

/** Caption family name for the ASS style: the requested one if its file is bundled, else Inter. */
export function captionFamily(requested?: string): string {
  if (requested && fs.existsSync(captionFontsDir()) && fs.readdirSync(captionFontsDir()).some((f) => /\.(ttf|otf)$/i.test(f) && norm(f).startsWith(norm(requested)))) return requested;
  return "Inter";
}

/** A path inside an FFmpeg filter argument: forward slashes, escaped colon / quote. */
export const filterPath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
